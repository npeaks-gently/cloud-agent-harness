/**
 * Intake stage handler for pipeline initialization.
 *
 * Creates the pipeline_run record in Postgres, creates a feature branch
 * on GitHub, creates a parent Linear ticket, and enriches the stage
 * message context for downstream stages.
 *
 * @see D-03 Pipeline triggered by SQS job message
 * @see D-05 Feature branch created at intake stage
 * @see D-09 Pipeline-created tickets at intake
 * @see D-14 Pipeline-level state in pipeline_runs table
 */

import type { Pool } from 'pg';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { PipelineStage, PipelineError, type StageMessage, type StageResult } from '../types.js';
import { parseRepoUrl } from '../utils.js';
import { createFeatureBranch } from '../../integrations/github.js';
import { createParentTicket } from '../../integrations/linear.js';
import { updatePipelineRunBranch, updatePipelineRunLinearTicket } from '../../postgres-client.js';
import { track } from '../../analytics.js';

// Re-export for backward compatibility (tests import from intake.js)
export { parseRepoUrl } from '../utils.js';

// --- Intake handler ----------------------------------------------------------

/**
 * Handles the intake stage by creating the pipeline_run record,
 * creating a feature branch on GitHub, and creating a parent
 * Linear ticket.
 *
 * The stage router generates the runId via crypto.randomUUID() and passes
 * it in the StageMessage. Intake inserts the pipeline_run row using the
 * pre-generated runId. ON CONFLICT DO NOTHING ensures idempotency on replay.
 *
 * After persisting the run, the handler:
 * 1. Creates a feature branch on GitHub (D-05)
 * 2. Creates a parent Linear ticket (D-09)
 * 3. Updates pipeline_runs with branch and ticket ID
 * 4. Enriches msg.context for downstream stages
 *
 * @param msg - Stage message containing runId and pipeline context
 * @param pool - Postgres connection pool
 * @returns Stage result with status 'completed' and no tasks
 * @throws {PipelineError} When a database or integration call fails
 *
 * @example
 * const result = await handleIntakeStage(stageMessage, pool);
 * // result.status === 'completed'
 * // msg.context.featureBranch is now set
 * // msg.context.linearParentTicketId is now set
 */
export async function handleIntakeStage(
  msg: StageMessage,
  pool: Pool,
): Promise<StageResult> {
  // Step 1: Insert pipeline_run record (idempotent via ON CONFLICT)
  const sql = `
    INSERT INTO pipeline_runs (id, project_id, phase_total, config, status, repo_url, branch, feature_description)
    VALUES ($1::uuid, $2, $3, $4, 'running', $5, $6, $7)
    ON CONFLICT (id) DO NOTHING
  `;

  try {
    await pool.query(sql, [
      msg.runId,
      msg.projectId,
      msg.context.phaseTotal,
      JSON.stringify({ featureDescription: msg.context.featureDescription }),
      msg.repoUrl,
      msg.branch,
      msg.context.featureDescription,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to insert pipeline run: ${message}`,
      'handleIntakeStage',
      PipelineStage.Intake,
    );
  }

  // Step 1.5: Download pre-uploaded planning artifacts (D-13)
  if (msg.context.planningPrefix) {
    // Validate planningPrefix format (T-04-01: prevent path traversal)
    const prefixPattern = /^triggers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/planning\/$/;
    if (!prefixPattern.test(msg.context.planningPrefix)) {
      throw new PipelineError(
        `Invalid planningPrefix format: ${msg.context.planningPrefix}`,
        'handleIntakeStage',
        PipelineStage.Intake,
      );
    }

    try {
      const bucket = process.env.CAH_ARTIFACT_BUCKET;
      if (!bucket) {
        throw new Error('CAH_ARTIFACT_BUCKET environment variable is not set');
      }

      const s3 = new S3Client({ region: 'us-east-1' });
      let continuationToken: string | undefined;
      let copiedCount = 0;

      // List all objects under the trigger prefix and copy to runs/{runId}/planning/
      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: msg.context.planningPrefix,
            ContinuationToken: continuationToken,
          }),
        );

        for (const obj of response.Contents ?? []) {
          const key = obj.Key;
          if (!key || key.length <= msg.context.planningPrefix.length) continue;

          const relativePath = key.slice(msg.context.planningPrefix.length);
          const destKey = `runs/${msg.runId}/planning/${relativePath}`;

          // Download from trigger prefix and re-upload to run prefix
          const getResponse = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
          );
          if (!getResponse.Body) continue;

          const bytes = await getResponse.Body.transformToByteArray();
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: destKey,
              Body: Buffer.from(bytes),
              ChecksumAlgorithm: 'SHA256',
            }),
          );
          copiedCount++;
        }

        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);

      console.log(JSON.stringify({
        level: 'info',
        message: 'Planning artifacts copied from trigger prefix to run prefix',
        runId: msg.runId,
        planningPrefix: msg.context.planningPrefix,
        copiedCount,
      }));
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new PipelineError(
        `Failed to download planning artifacts: ${message}`,
        'handleIntakeStage',
        PipelineStage.Intake,
      );
    }
  }

  // Step 2: Create feature branch on GitHub (D-05)
  const { owner, repo } = parseRepoUrl(msg.repoUrl, 'handleIntakeStage', PipelineStage.Intake);
  const shortRunId = msg.runId.slice(0, 8);
  const featureSlug = msg.context.featureDescription
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const featureBranch = `cah/${shortRunId}/${featureSlug}`;

  try {
    await createFeatureBranch(owner, repo, featureBranch, msg.branch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to create feature branch: ${message}`,
      'handleIntakeStage',
      PipelineStage.Intake,
    );
  }

  try {
    await updatePipelineRunBranch(pool, msg.runId, featureBranch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to update pipeline run branch: ${message}`,
      'handleIntakeStage',
      PipelineStage.Intake,
    );
  }

  // Step 3: Create parent Linear ticket (D-09)
  let linearParentTicketId: string;
  try {
    const ticket = await createParentTicket(msg.runId, msg.context.featureDescription);
    linearParentTicketId = ticket.ticketId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to create parent Linear ticket: ${message}`,
      'handleIntakeStage',
      PipelineStage.Intake,
    );
  }

  try {
    await updatePipelineRunLinearTicket(pool, msg.runId, linearParentTicketId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to update pipeline run Linear ticket: ${message}`,
      'handleIntakeStage',
      PipelineStage.Intake,
    );
  }

  // Step 4: Track pipeline_started event (D-14)
  track('pipeline_started', {
    runId: msg.runId,
    projectId: msg.projectId,
    stage: PipelineStage.Intake,
    featureBranch,
    linearParentTicketId,
    hasPlanningContext: !!msg.context.planningPrefix,
  });

  // Step 5: Enrich msg.context so downstream stages have branch and ticket
  msg.context.featureBranch = featureBranch;
  msg.context.linearParentTicketId = linearParentTicketId;

  console.log(JSON.stringify({
    level: 'info',
    message: 'Intake stage completed',
    runId: msg.runId,
    featureBranch,
    linearParentTicketId,
  }));

  return { stage: PipelineStage.Intake, status: 'completed', tasks: [] };
}

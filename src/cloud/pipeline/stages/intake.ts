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
import { PipelineStage, PipelineError, type StageMessage, type StageResult } from '../types.js';
import { createFeatureBranch } from '../../integrations/github.js';
import { createParentTicket } from '../../integrations/linear.js';
import { updatePipelineRunBranch, updatePipelineRunLinearTicket } from '../../postgres-client.js';
import { track } from '../../analytics.js';

// --- Helpers -----------------------------------------------------------------

/**
 * Parses a GitHub repository URL into owner and repo components.
 *
 * Handles both full URLs (https://github.com/owner/repo) and
 * shorthand format (owner/repo). Strips trailing .git if present.
 *
 * @param url - Repository URL or owner/repo string
 * @returns Object with owner and repo strings
 * @throws {PipelineError} When the URL cannot be parsed
 */
export function parseRepoUrl(url: string): { owner: string; repo: string } {
  // Strip trailing .git
  const cleaned = url.replace(/\.git$/, '');

  // Try full URL: https://github.com/owner/repo
  const urlMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  // Try shorthand: owner/repo
  const shortMatch = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  throw new PipelineError(
    `Cannot parse repository URL: ${url}`,
    'parseRepoUrl',
    PipelineStage.Intake,
  );
}

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

  // Step 2: Create feature branch on GitHub (D-05)
  const { owner, repo } = parseRepoUrl(msg.repoUrl);
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

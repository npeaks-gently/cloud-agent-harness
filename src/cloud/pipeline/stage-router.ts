/**
 * Stage router for pipeline SQS message dispatch.
 *
 * The Lambda handler entry point that receives SQS messages from TWO queues:
 * 1. Job queue -- PipelineJobMessage (new pipeline requests from external callers)
 * 2. Stage queue -- StageMessage (pipeline progression between stages)
 *
 * The router distinguishes between the two message types using type guards,
 * dispatches to the correct stage handler, updates pipeline state, and sends
 * the next-stage SQS message to continue the pipeline.
 *
 * @see D-02 Lambda per pipeline stage with SQS messages
 * @see D-03 Pipeline triggered by SQS job message
 * @see T-02-12 Dual type guards validate all required fields
 */

import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import type { DaytonaClient } from '../daytona-client.js';
import type { PipelineJobMessage } from '../types.js';
import {
  PipelineStage,
  NEXT_STAGE,
  type StageMessage,
  type StageResult,
} from './types.js';
import { updatePipelineStage } from './checkpoint.js';
import { track, flush } from '../analytics.js';
import { createSubTicket, updateTicketStatus } from '../integrations/linear.js';
import { handleIntakeStage } from './stages/intake.js';
import { handleResearchStage } from './stages/research.js';
import { handlePlanStage } from './stages/plan.js';
import { handleApproveStage } from './stages/approve.js';
import { handleExecuteStage } from './stages/execute.js';
import { handleVerifyStage } from './stages/verify.js';
import { handlePrStage } from './stages/pr.js';

// --- Constants ---------------------------------------------------------------

const DEFAULT_REGION = 'us-east-1';

// --- Error -------------------------------------------------------------------

/**
 * Error thrown by the stage router when message parsing or routing fails.
 *
 * Includes the operation name and optionally the pipeline stage where
 * the error occurred.
 *
 * @see T-02-15 Error messages include operation name but not sensitive data
 */
export class StageRouterError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly stage?: string,
  ) {
    super(message);
    this.name = 'StageRouterError';
  }
}

// --- Type guards -------------------------------------------------------------

/**
 * Type guard for StageMessage (inter-stage pipeline progression).
 *
 * Validates all required fields: runId, projectId, repoUrl, branch,
 * stage (must be a valid PipelineStage enum value), and context object.
 */
function isStageMessage(body: unknown): body is StageMessage {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.runId === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.repoUrl === 'string' &&
    typeof obj.branch === 'string' &&
    typeof obj.stage === 'string' &&
    Object.values(PipelineStage).includes(obj.stage as PipelineStage) &&
    typeof obj.context === 'object' && obj.context !== null
  );
}

/**
 * Type guard for PipelineJobMessage (new pipeline request from job queue).
 *
 * Validates all required fields and checks that the 'stage' field is absent
 * to distinguish from StageMessage (T-02-12).
 */
function isPipelineJobMessage(body: unknown): body is PipelineJobMessage {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.repoUrl === 'string' &&
    typeof obj.branch === 'string' &&
    typeof obj.featureDescription === 'string' &&
    // Must NOT have a 'stage' field (distinguishes from StageMessage)
    obj.stage === undefined
  );
}

// --- Stage dispatch map ------------------------------------------------------

const STAGE_HANDLERS: Record<PipelineStage, (
  msg: StageMessage,
  pool: Pool,
  client: DaytonaClient,
  bucket: string,
) => Promise<StageResult>> = {
  [PipelineStage.Intake]: (msg, pool) => handleIntakeStage(msg, pool),
  [PipelineStage.Research]: handleResearchStage,
  [PipelineStage.Plan]: handlePlanStage,
  [PipelineStage.Approve]: (msg, pool) => handleApproveStage(msg, pool),
  [PipelineStage.Execute]: handleExecuteStage,
  [PipelineStage.Verify]: handleVerifyStage,
  [PipelineStage.PR]: (msg, pool) => handlePrStage(msg, pool),
};

// --- Job message -> StageMessage conversion ----------------------------------

/**
 * Converts a PipelineJobMessage (from job queue) into a StageMessage
 * for intake processing. Generates a new runId via crypto.randomUUID().
 *
 * @param job - PipelineJobMessage from the job queue
 * @returns StageMessage for the intake stage
 */
function jobMessageToIntakeStageMessage(job: PipelineJobMessage): StageMessage {
  return {
    runId: randomUUID(),
    projectId: job.projectId,
    repoUrl: job.repoUrl,
    branch: job.branch,
    stage: PipelineStage.Intake,
    context: {
      featureDescription: job.featureDescription,
      phaseNumber: 1,
      phaseTotal: 1,
      previousArtifacts: [],
      planningPrefix: job.planningPrefix,
    },
  };
}

// --- Router ------------------------------------------------------------------

/**
 * Routes an SQS message to the correct stage handler.
 *
 * Handles TWO message types:
 * 1. PipelineJobMessage from the job queue (new pipeline) --
 *    generates runId, constructs intake StageMessage, dispatches to intake.
 * 2. StageMessage from the stage queue (pipeline progression) --
 *    dispatches to the correct stage handler based on msg.stage.
 *
 * After the handler completes, updates pipeline state and sends the
 * next-stage SQS message (unless terminal or failed).
 *
 * @param messageBody - Raw SQS message body (JSON string)
 * @param pool - Postgres connection pool
 * @param client - DaytonaClient for sandbox management
 * @param bucket - S3 bucket name for artifact storage
 * @param stageQueueUrl - SQS queue URL for next-stage messages
 * @param sqsClient - Optional SQS client (injected for testing)
 * @returns Stage result from the handler
 * @throws {StageRouterError} When message parsing fails or schema is invalid
 *
 * @example
 * const result = await routeStage(messageBody, pool, client, bucket, queueUrl);
 */
export async function routeStage(
  messageBody: string,
  pool: Pool,
  client: DaytonaClient,
  bucket: string,
  stageQueueUrl: string,
  sqsClient?: SQSClient,
): Promise<StageResult> {
  // Step 1: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageBody);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new StageRouterError(
      `Failed to parse message body: ${errMsg}`,
      'routeStage',
    );
  }

  // Step 2: Determine message type and get StageMessage
  let msg: StageMessage;

  if (isStageMessage(parsed)) {
    // Inter-stage pipeline progression (from stage queue)
    msg = parsed;
  } else if (isPipelineJobMessage(parsed)) {
    // New pipeline request (from job queue) -- generate runId, create intake StageMessage
    msg = jobMessageToIntakeStageMessage(parsed);
  } else {
    throw new StageRouterError(
      'Message body matches neither StageMessage nor PipelineJobMessage schema',
      'routeStage',
    );
  }

  // Step 3a: D-10 sub-ticket creation at execute stage entry
  if (msg.stage === PipelineStage.Execute && msg.context.linearParentTicketId) {
    try {
      const phaseName = `Phase ${msg.context.phaseNumber}`;
      const { ticketId: subTicketId } = await createSubTicket(
        msg.context.linearParentTicketId,
        msg.context.phaseNumber,
        phaseName,
      );
      // Update sub-ticket to in_progress
      await updateTicketStatus(subTicketId, 'in_progress');
      console.log(JSON.stringify({
        level: 'info',
        message: 'Linear sub-ticket created for phase',
        runId: msg.runId,
        phaseNumber: msg.context.phaseNumber,
        subTicketId,
      }));
    } catch (err) {
      // Linear sub-ticket creation is non-critical -- log and continue (T-03-15a)
      console.log(JSON.stringify({
        level: 'warn',
        message: 'Failed to create Linear sub-ticket',
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Step 3b: Dispatch to stage handler
  const handler = STAGE_HANDLERS[msg.stage];
  const result = await handler(msg, pool, client, bucket);

  // Step 3c: PostHog stage tracking (D-14)
  track('stage_completed', {
    runId: msg.runId,
    projectId: msg.projectId,
    stage: msg.stage,
    status: result.status,
  });

  // Step 4: Update pipeline state in Postgres
  if (result.status === 'failed') {
    // Mark the pipeline as failed at the current stage -- do not advance
    await pool.query(
      `UPDATE pipeline_runs SET status = 'failed', current_stage = $1 WHERE id = $2`,
      [msg.stage, msg.runId],
    );
  } else if (result.status === 'paused') {
    // D-03: Approve stage returned 'paused' -- do NOT advance pipeline
    // The Slack webhook Lambda handles re-enqueue on approval
    await pool.query(
      `UPDATE pipeline_runs SET current_stage = $1, status = 'paused' WHERE id = $2`,
      [msg.stage, msg.runId],
    );
    // No SQS advance -- webhook Lambda is responsible for resuming
  } else {
    const nextStage = NEXT_STAGE[msg.stage];
    await updatePipelineStage(pool, msg.runId, nextStage);

    // D-10: Update Linear ticket status at stage transitions
    if (msg.context.linearParentTicketId) {
      try {
        await updateTicketStatus(msg.context.linearParentTicketId, 'in_progress');
      } catch (err) {
        console.log(JSON.stringify({
          level: 'warn',
          message: 'Failed to update Linear ticket status at stage transition',
          runId: msg.runId,
          stage: msg.stage,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    // Step 5: Send next-stage SQS message (if not terminal)
    if (nextStage !== null) {
      const sqs = sqsClient ?? new SQSClient({ region: DEFAULT_REGION });
      const nextMsg: StageMessage = {
        ...msg,
        stage: nextStage,
        context: {
          ...msg.context,
          previousArtifacts: [
            ...msg.context.previousArtifacts,
            ...result.tasks.flatMap(t => t.artifacts),
          ],
        },
      };

      await sqs.send(new SendMessageCommand({
        QueueUrl: stageQueueUrl,
        MessageBody: JSON.stringify(nextMsg),
      }));
    }
  }

  await flush();
  return result;
}

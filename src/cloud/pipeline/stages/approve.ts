/**
 * Approve stage handler for pipeline plan approval via Slack.
 *
 * Sends a Block Kit approval message to Slack, persists an approval
 * token to Postgres, and returns 'paused' status. The pipeline remains
 * paused until the Slack webhook Lambda resolves the approval and
 * re-enqueues the next stage message.
 *
 * @see D-01 Approve stage sends Slack message and returns 'paused'
 * @see D-04 Block Kit approve/reject buttons
 * @see T-03-09 Approval token is UUID v4 (122 bits entropy)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PipelineStage, PipelineError, type StageMessage, type StageResult } from '../types.js';
import { sendApprovalMessage } from '../../integrations/slack.js';
import { insertApproval } from '../../postgres-client.js';
import { track } from '../../analytics.js';

// --- Approve handler ---------------------------------------------------------

/**
 * Handles the approve stage by sending a Slack approval message
 * and persisting the approval token to Postgres.
 *
 * The handler returns 'paused' status so the stage router does NOT
 * advance the pipeline via SQS. The Slack webhook Lambda is responsible
 * for resolving the approval and re-enqueuing the next stage.
 *
 * @param msg - Stage message with pipeline context
 * @param pool - Postgres connection pool for approval persistence
 * @returns Stage result with status 'paused' and no tasks
 * @throws {PipelineError} When Slack send or Postgres insert fails
 *
 * @example
 * const result = await handleApproveStage(stageMessage, pool);
 * // result.status === 'paused'
 */
export async function handleApproveStage(
  msg: StageMessage,
  pool: Pool,
): Promise<StageResult> {
  // Step 1: Generate approval token (T-03-09: UUID v4, 122 bits entropy)
  const token = randomUUID();

  // Step 2: Read Slack channel from environment
  const channel = process.env.SLACK_APPROVAL_CHANNEL ?? '';

  // Step 3: Build plan summary for the Slack message
  const planSummary = [
    `*Feature:* ${msg.context.featureDescription}`,
    `*Phase:* ${msg.context.phaseNumber} of ${msg.context.phaseTotal}`,
    `*Project:* \`${msg.projectId}\``,
  ].join('\n');

  // Steps 4-5: Send Slack message and persist token (wrapped for error handling)
  let messageTs: string;
  try {
    messageTs = await sendApprovalMessage(channel, msg.runId, msg.projectId, token, planSummary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to send Slack approval message: ${message}`,
      'handleApproveStage',
      PipelineStage.Approve,
    );
  }

  try {
    await insertApproval(pool, msg.runId, token, channel, messageTs, 'plan_approval');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to persist approval token: ${message}`,
      'handleApproveStage',
      PipelineStage.Approve,
    );
  }

  // Step 6: Track approval event (D-14)
  track('approval_requested', {
    runId: msg.runId,
    projectId: msg.projectId,
    stage: PipelineStage.Approve,
  });

  // Step 7: CloudWatch log (T-03-11: includes runId and token but NOT message content)
  console.log(JSON.stringify({
    level: 'info',
    message: 'Approval requested via Slack',
    runId: msg.runId,
    token,
  }));

  // Step 8: Return paused -- stage router will NOT advance pipeline via SQS
  return { stage: PipelineStage.Approve, status: 'paused', tasks: [] };
}

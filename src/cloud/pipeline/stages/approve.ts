/**
 * Approve stage handler for pipeline plan approval.
 *
 * Auto-approves the pipeline and continues execution. This is a
 * placeholder for Phase 3 Slack integration (D-10) where users
 * will approve/reject plans via Slack buttons.
 *
 * @see D-10 Approve stage auto-approve until Phase 3 Slack integration
 */

import type { Pool } from 'pg';
import { PipelineStage, type StageMessage, type StageResult } from '../types.js';

// --- Approve handler ---------------------------------------------------------

/**
 * Handles the approve stage by auto-approving the pipeline plan.
 *
 * In v1, this stage immediately returns 'completed' without user
 * interaction. Phase 3 will replace this with Slack-based approval
 * (INTG-01) where the plan is sent to Slack and the pipeline pauses
 * until the user clicks Approve or Reject.
 *
 * @param msg - Stage message with pipeline context
 * @param _pool - Postgres connection pool (unused in auto-approve)
 * @returns Stage result with status 'completed' and no tasks
 *
 * @example
 * const result = await handleApproveStage(stageMessage, pool);
 * // result.status === 'completed' (auto-approved)
 */
export async function handleApproveStage(
  msg: StageMessage,
  _pool: Pool,
): Promise<StageResult> {
  // D-10: Auto-approve until Phase 3 Slack integration
  // Log auto-approval for observability (CloudWatch structured logging)
  console.log(JSON.stringify({
    level: 'info',
    message: 'Auto-approved pipeline plan',
    runId: msg.runId,
    projectId: msg.projectId,
    stage: PipelineStage.Approve,
  }));

  return { stage: PipelineStage.Approve, status: 'completed', tasks: [] };
}

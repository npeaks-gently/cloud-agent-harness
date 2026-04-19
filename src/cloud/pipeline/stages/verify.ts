/**
 * Verify stage handler for spawning the verifier agent.
 *
 * Dispatches a single verifier agent to a Daytona sandbox. Checks
 * for previously completed tasks before dispatching (resume support).
 *
 * @see D-11 Each stage maps to one or more Daytona sandbox tasks
 * @see D-13 Resume reads agent_runs and skips completed tasks
 */

import type { Pool } from 'pg';
import type { DaytonaClient } from '../../daytona-client.js';
import {
  PipelineStage,
  type StageMessage,
  type StageResult,
} from '../types.js';
import { buildTaskId, getCompletedTasks } from '../idempotency.js';
import { runAgentTask } from '../sandbox-task.js';

// --- Verify handler ----------------------------------------------------------

/**
 * Handles the verify stage by spawning a verifier agent in Daytona.
 *
 * Dispatches a single verifier agent that validates the execution
 * results against requirements. Checks getCompletedTasks before
 * dispatching to skip already-completed tasks on pipeline replay.
 *
 * @param msg - Stage message with pipeline context
 * @param pool - Postgres connection pool for checkpoint queries
 * @param client - DaytonaClient for sandbox management
 * @param bucket - S3 bucket name for artifact storage
 * @returns Stage result with status 'completed', 'failed', or 'skipped'
 *
 * @example
 * const result = await handleVerifyStage(msg, pool, client, 'cah-artifacts');
 */
export async function handleVerifyStage(
  msg: StageMessage,
  pool: Pool,
  client: DaytonaClient,
  bucket: string,
): Promise<StageResult> {
  const taskKey = buildTaskId(msg.runId, 'verify', 'verify-main', 1);

  // Check for previously completed tasks (resume support, D-13)
  const completed = await getCompletedTasks(pool, msg.runId, 'verify');
  if (completed.includes(taskKey)) {
    return { stage: PipelineStage.Verify, status: 'skipped', tasks: [] };
  }

  // Dispatch single verifier agent to Daytona (D-11)
  const result = await runAgentTask(client, pool, bucket, {
    msg,
    plan: 'verify-main',
    wave: 1,
    command: 'node /harness/entrypoint.js',
  });

  return {
    stage: PipelineStage.Verify,
    status: result.success ? 'completed' : 'failed',
    tasks: [result],
  };
}

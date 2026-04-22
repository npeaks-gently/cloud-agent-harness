/**
 * Research stage handler for spawning research agent(s).
 *
 * Dispatches a single research agent to a Daytona sandbox. Checks
 * for previously completed tasks before dispatching (resume support).
 * Parallel research agents are deferred to v2 (D-11).
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

// --- Research handler --------------------------------------------------------

/**
 * Handles the research stage by spawning a research agent in Daytona.
 *
 * For v1, dispatches a single research agent (parallel research deferred
 * to v2). Checks getCompletedTasks before dispatching to skip already-
 * completed tasks on pipeline replay.
 *
 * @param msg - Stage message with pipeline context
 * @param pool - Postgres connection pool for checkpoint queries
 * @param client - DaytonaClient for sandbox management
 * @param bucket - S3 bucket name for artifact storage
 * @returns Stage result with status 'completed', 'failed', or 'skipped'
 *
 * @example
 * const result = await handleResearchStage(msg, pool, client, 'cah-artifacts');
 */
export async function handleResearchStage(
  msg: StageMessage,
  pool: Pool,
  client: DaytonaClient,
  bucket: string,
): Promise<StageResult> {
  const taskKey = buildTaskId(msg.runId, 'research', 'research-main', 1);

  // Check for previously completed tasks (resume support, D-13)
  const completed = await getCompletedTasks(pool, msg.runId, 'research');
  if (completed.includes(taskKey)) {
    return { stage: PipelineStage.Research, status: 'skipped', tasks: [] };
  }

  // Dispatch single research agent to Daytona (D-11)
  const result = await runAgentTask(client, pool, bucket, {
    msg,
    plan: 'research-main',
    wave: 1,
    command: 'node /harness/entrypoint.js',
  });

  return {
    stage: PipelineStage.Research,
    status: result.success ? 'completed' : 'failed',
    tasks: [result],
  };
}

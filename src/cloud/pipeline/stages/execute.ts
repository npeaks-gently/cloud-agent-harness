/**
 * Execute stage handler for spawning executor agents per plan/wave.
 *
 * The most complex stage: iterates plans sequentially for v1 (parallel
 * deferred to v2 EXEC-02). Each plan dispatches to a Daytona sandbox
 * via runAgentTask. Stops on first failure.
 *
 * @see D-11 Execute spawns agents per plan/wave
 * @see D-13 Resume reads agent_runs and skips completed tasks
 * @see T-02-14 No unbounded loops -- planCount from pipeline context
 */

import type { Pool } from 'pg';
import type { DaytonaClient } from '../../daytona-client.js';
import {
  PipelineStage,
  type StageMessage,
  type StageResult,
  type AgentTaskOutcome,
} from '../types.js';
import { buildTaskId, getCompletedTasks } from '../idempotency.js';
import { runAgentTask } from '../sandbox-task.js';

// --- Execute handler ---------------------------------------------------------

/**
 * Handles the execute stage by spawning executor agents per plan.
 *
 * Iterates plans sequentially for v1. For each plan, checks if it has
 * already been completed (resume support), then dispatches to Daytona.
 * Stops on first failure and returns all accumulated task outcomes.
 *
 * Plan count comes from the pipeline context. If not set, defaults to 1.
 * The planner agent sets this value during the plan stage.
 *
 * @param msg - Stage message with pipeline context
 * @param pool - Postgres connection pool for checkpoint queries
 * @param client - DaytonaClient for sandbox management
 * @param bucket - S3 bucket name for artifact storage
 * @returns Stage result with accumulated task outcomes
 *
 * @example
 * const result = await handleExecuteStage(msg, pool, client, 'cah-artifacts');
 */
export async function handleExecuteStage(
  msg: StageMessage,
  pool: Pool,
  client: DaytonaClient,
  bucket: string,
): Promise<StageResult> {
  // Single sandbox dispatch per phase. The sandbox runs gsd.runPhase(phase),
  // which iterates the GSD-internal plan list for that phase in one process.
  // The per-cloud-plan loop the previous implementation tried to drive
  // didn't match the SDK API (executePlan expects a path, not an ID).
  // Phase 5 will revisit fan-out / parallelism if needed.
  const planName = 'execute-main';
  const wave = 1;
  const taskKey = buildTaskId(msg.runId, 'execute', planName, wave);

  const completed = await getCompletedTasks(pool, msg.runId, 'execute');
  if (completed.includes(taskKey)) {
    return { stage: PipelineStage.Execute, status: 'completed', tasks: [] };
  }

  const result = await runAgentTask(client, pool, bucket, {
    msg,
    plan: planName,
    wave,
    command: 'node /harness/entrypoint.js',
    timeoutSeconds: 1800,
  });

  if (!result.success) {
    return {
      stage: PipelineStage.Execute,
      status: 'failed',
      tasks: [result],
      error: `Execute stage failed: ${result.error ?? 'no error message'}`,
    };
  }

  return {
    stage: PipelineStage.Execute,
    status: 'completed',
    tasks: [result],
  };
}

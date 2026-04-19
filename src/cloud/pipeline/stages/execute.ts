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
  // Plan count from pipeline context (set by planner, defaults to 1).
  // Validate at runtime: JSON deserialization may yield a string, so coerce safely.
  const rawPlanCount = (msg.context as Record<string, unknown>).planCount;
  const planCount = typeof rawPlanCount === 'number' && rawPlanCount > 0
    ? rawPlanCount
    : 1;

  // Get all completed tasks for this run's execute stage (resume support, D-13)
  const completed = await getCompletedTasks(pool, msg.runId, 'execute');

  const allOutcomes: AgentTaskOutcome[] = [];

  // Iterate plans sequentially (parallel deferred to v2 EXEC-02)
  for (let plan = 1; plan <= planCount; plan++) {
    const planName = `execute-${String(plan).padStart(2, '0')}`;
    const taskKey = buildTaskId(msg.runId, 'execute', planName, 1);

    // Skip already-completed plans
    if (completed.includes(taskKey)) {
      continue;
    }

    // Dispatch executor agent to Daytona (D-11)
    const result = await runAgentTask(client, pool, bucket, {
      msg,
      plan: planName,
      wave: 1,
      command: 'node /harness/entrypoint.js',
    });

    allOutcomes.push(result);

    // Stop on first failure
    if (!result.success) {
      return {
        stage: PipelineStage.Execute,
        status: 'failed',
        tasks: allOutcomes,
        error: `Plan ${planName} failed`,
      };
    }
  }

  return {
    stage: PipelineStage.Execute,
    status: 'completed',
    tasks: allOutcomes,
  };
}

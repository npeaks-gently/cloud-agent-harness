/**
 * Idempotency layer for pipeline agent task execution.
 *
 * Provides deterministic task ID generation and idempotent upsert
 * for the agent_runs table. Prevents duplicate agent execution on
 * pipeline replay by using the task_key column as a conflict target.
 *
 * @see D-15 Idempotent task IDs
 * @see STATE-03 Idempotency keys on all external writes
 */

import type { Pool } from 'pg';
import type { AgentRunData } from './types.js';
import { PipelineError } from './types.js';

// --- Task ID generation ------------------------------------------------------

/**
 * Builds a deterministic task ID from pipeline run components.
 *
 * The resulting colon-separated string serves as the unique key
 * for both Postgres upserts (task_key column) and S3 artifact
 * prefixes. Re-running a task with the same components produces
 * the same ID, enabling idempotent writes.
 *
 * @param runId - Pipeline run UUID
 * @param phase - Phase identifier (e.g., "research", "execute")
 * @param plan - Plan name within the phase (e.g., "main", "02-01")
 * @param wave - Execution wave number
 * @returns Deterministic task key in format `{runId}:{phase}:{plan}:{wave}`
 *
 * @example
 * buildTaskId('run-1', 'research', 'main', 1) // 'run-1:research:main:1'
 * buildTaskId('run-1', 'execute', '02-01', 2) // 'run-1:execute:02-01:2'
 */
export function buildTaskId(
  runId: string,
  phase: string,
  plan: string,
  wave: number,
): string {
  return `${runId}:${phase}:${plan}:${wave}`;
}

// --- Idempotent upsert -------------------------------------------------------

/**
 * Inserts or updates an agent run record using the task_key for idempotency.
 *
 * Uses INSERT ... ON CONFLICT (task_key) DO UPDATE to safely handle
 * replayed pipeline stages. If an agent_run with the same task_key
 * already exists, the status is updated but started_at is preserved
 * for completed/failed runs (prevents overwriting historical timing).
 *
 * @param pool - Postgres connection pool
 * @param taskKey - Deterministic task key from buildTaskId()
 * @param data - Agent run data to insert or update
 * @throws {PipelineError} When the database query fails
 *
 * @example
 * const taskKey = buildTaskId(runId, 'research', 'main', 1);
 * await upsertAgentRun(pool, taskKey, {
 *   pipelineRunId: runId,
 *   phase: 1,
 *   planName: 'main',
 *   wave: 1,
 *   status: 'running',
 * });
 */
export async function upsertAgentRun(
  pool: Pool,
  taskKey: string,
  data: AgentRunData,
): Promise<void> {
  const sql = `
    INSERT INTO agent_runs (id, pipeline_run_id, phase, plan_name, wave, status, started_at, task_key)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), $6)
    ON CONFLICT (task_key) WHERE task_key IS NOT NULL DO UPDATE SET
      status = EXCLUDED.status,
      started_at = CASE
        WHEN agent_runs.status IN ('completed', 'failed') THEN agent_runs.started_at
        ELSE EXCLUDED.started_at
      END
  `;

  const params = [
    data.pipelineRunId,
    data.phase,
    data.planName,
    data.wave,
    data.status,
    taskKey,
  ];

  try {
    await pool.query(sql, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to upsert agent run: ${message}`,
      'upsertAgentRun',
      'agent_runs',
    );
  }
}

// --- Completed task query ----------------------------------------------------

/**
 * Retrieves task keys for completed agent runs within a pipeline run.
 *
 * Used during pipeline resume to determine which tasks can be skipped.
 * Optionally filters by stage/plan_name prefix (e.g., "research" matches
 * all research-stage tasks).
 *
 * @param pool - Postgres connection pool
 * @param pipelineRunId - Pipeline run UUID to query
 * @param stage - Optional stage prefix to filter by (uses plan_name LIKE '{stage}%')
 * @returns Array of completed task_key strings
 * @throws {PipelineError} When the database query fails
 *
 * @example
 * // All completed tasks for a run
 * const all = await getCompletedTasks(pool, runId);
 *
 * // Only research stage tasks
 * const research = await getCompletedTasks(pool, runId, 'research');
 */
export async function getCompletedTasks(
  pool: Pool,
  pipelineRunId: string,
  stage?: string,
): Promise<string[]> {
  let sql: string;
  let params: unknown[];

  if (stage) {
    sql = `
      SELECT task_key FROM agent_runs
      WHERE pipeline_run_id = $1
        AND status = 'completed'
        AND plan_name LIKE $2
    `;
    params = [pipelineRunId, `${stage}%`];
  } else {
    sql = `
      SELECT task_key FROM agent_runs
      WHERE pipeline_run_id = $1
        AND status = 'completed'
    `;
    params = [pipelineRunId];
  }

  try {
    const result = await pool.query(sql, params);
    return result.rows.map((r: { task_key: string }) => r.task_key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to get completed tasks: ${message}`,
      'getCompletedTasks',
      'agent_runs',
    );
  }
}

/**
 * Checkpoint read/write operations for pipeline and agent state.
 *
 * Persists agent task results to Postgres after every task (D-12)
 * and tracks pipeline-level stage progression (D-14). Used by the
 * resume module to determine skip lists on pipeline replay.
 *
 * @see STATE-01 Postgres-backed checkpoint at wave and phase boundaries
 * @see D-12 Per agent task checkpoint granularity
 * @see D-14 Pipeline-level state in pipeline_runs table
 */

import type { Pool } from 'pg';
import type { AgentRunData, AgentTaskOutcome } from './types.js';
import { PipelineError, PipelineStage } from './types.js';
import { upsertAgentRun, getCompletedTasks } from './idempotency.js';

// --- Agent checkpoint --------------------------------------------------------

/**
 * Records an agent task completion to Postgres.
 *
 * Performs two writes:
 * 1. Upserts the agent_run row via the idempotency module (status set
 *    based on outcome.success).
 * 2. Updates the row with outcome details (cost, duration, artifacts,
 *    error message, completed_at timestamp).
 *
 * @param pool - Postgres connection pool
 * @param taskKey - Deterministic task key from buildTaskId()
 * @param data - Agent run data for the upsert
 * @param outcome - Task execution outcome with metrics
 * @throws {PipelineError} When a database query fails
 *
 * @example
 * await writeAgentCheckpoint(pool, 'run-1:2:02-01:1', agentData, outcome);
 */
export async function writeAgentCheckpoint(
  pool: Pool,
  taskKey: string,
  data: AgentRunData,
  outcome: AgentTaskOutcome,
): Promise<void> {
  // Step 1: Upsert the agent_run row with appropriate status
  await upsertAgentRun(pool, taskKey, {
    ...data,
    status: outcome.success ? 'completed' : 'failed',
  });

  // Step 2: Update with outcome details
  const sql = `
    UPDATE agent_runs SET
      cost_usd = $1,
      duration_ms = $2,
      artifacts = $3,
      error_message = $4,
      completed_at = NOW()
    WHERE task_key = $5
  `;

  try {
    await pool.query(sql, [
      outcome.costUsd,
      outcome.durationMs,
      JSON.stringify(outcome.artifacts),
      outcome.error ?? null,
      taskKey,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to update agent checkpoint: ${message}`,
      'writeAgentCheckpoint',
    );
  }
}

// --- Pipeline stage update ---------------------------------------------------

/**
 * Updates pipeline-level state after a stage completes.
 *
 * Sets current_stage and status in pipeline_runs. When stage is null
 * (the PR stage completed and there is no next stage), marks the
 * pipeline as 'completed'.
 *
 * @param pool - Postgres connection pool
 * @param runId - Pipeline run UUID
 * @param stage - Next pipeline stage, or null if pipeline is finished
 * @throws {PipelineError} When the database query fails
 *
 * @example
 * // Advance to research stage
 * await updatePipelineStage(pool, runId, PipelineStage.Research);
 *
 * // Mark pipeline as completed
 * await updatePipelineStage(pool, runId, null);
 */
export async function updatePipelineStage(
  pool: Pool,
  runId: string,
  stage: PipelineStage | null,
): Promise<void> {
  let sql: string;
  let params: unknown[];

  if (stage === null) {
    sql = `UPDATE pipeline_runs SET current_stage = 'completed', status = 'completed' WHERE id = $1`;
    params = [runId];
  } else {
    sql = `UPDATE pipeline_runs SET current_stage = $1, status = 'running' WHERE id = $2`;
    params = [stage, runId];
  }

  try {
    await pool.query(sql, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to update pipeline stage: ${message}`,
      'updatePipelineStage',
    );
  }
}

// --- Pipeline state query ----------------------------------------------------

/**
 * Reads the current pipeline state from Postgres.
 *
 * Returns the current stage, status, and a list of completed task
 * keys for the given run. Returns null if the run does not exist.
 *
 * @param pool - Postgres connection pool
 * @param runId - Pipeline run UUID
 * @returns Pipeline state or null if run not found
 * @throws {PipelineError} When a database query fails
 *
 * @example
 * const state = await getPipelineState(pool, runId);
 * if (state) {
 *   console.log(`Currently at stage ${state.currentStage}`);
 * }
 */
export async function getPipelineState(
  pool: Pool,
  runId: string,
): Promise<{ currentStage: string; status: string; completedTasks: string[] } | null> {
  const sql = `SELECT current_stage, status FROM pipeline_runs WHERE id = $1`;

  let row: { current_stage: string; status: string } | undefined;

  try {
    const result = await pool.query(sql, [runId]);
    if (result.rows.length === 0) return null;
    row = result.rows[0] as { current_stage: string; status: string };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to get pipeline state: ${message}`,
      'getPipelineState',
    );
  }

  const completedTasks = await getCompletedTasks(pool, runId);

  return {
    currentStage: row.current_stage,
    status: row.status,
    completedTasks,
  };
}

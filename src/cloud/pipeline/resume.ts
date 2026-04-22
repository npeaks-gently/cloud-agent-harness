/**
 * Pipeline resume logic for fault-tolerant execution.
 *
 * Reads pipeline state from Postgres and determines where to restart
 * after a failure. Returns the stage to resume from and the list of
 * completed tasks that should be skipped on replay.
 *
 * @see STATE-02 Resume from last good checkpoint on any transient failure
 * @see D-13 Resume reads agent_runs, identifies completed tasks, skips them
 */

import type { Pool } from 'pg';
import { PipelineError, PipelineStage } from './types.js';
import { getPipelineState } from './checkpoint.js';

// --- Resume ------------------------------------------------------------------

/**
 * Determines the resume point for a pipeline run.
 *
 * Queries pipeline state and returns:
 * - For a brand new run (pending/intake): stage = Intake, completedTasks = []
 * - For a partially completed run: stage = current_stage, completedTasks = [...completed]
 * - For a missing run: throws PipelineError
 *
 * The caller uses completedTasks to skip already-finished work and
 * begins execution from the returned stage.
 *
 * @param pool - Postgres connection pool
 * @param runId - Pipeline run UUID to resume
 * @returns The stage to start from and the list of completed task keys
 * @throws {PipelineError} When the pipeline run is not found
 *
 * @example
 * const { stage, completedTasks } = await resumePipeline(pool, runId);
 * // Execute starting from stage, skipping completedTasks
 */
export async function resumePipeline(
  pool: Pool,
  runId: string,
): Promise<{ stage: PipelineStage; completedTasks: string[] }> {
  const state = await getPipelineState(pool, runId);

  if (!state) {
    throw new PipelineError(
      `Pipeline run ${runId} not found`,
      'resumePipeline',
    );
  }

  // Determine resume stage from current pipeline state
  const resumeStage = (state.currentStage as PipelineStage) ?? PipelineStage.Intake;

  return {
    stage: resumeStage,
    completedTasks: state.completedTasks,
  };
}

/**
 * Intake stage handler for pipeline initialization.
 *
 * Creates the pipeline_run record in Postgres with the pre-generated
 * runId from the stage router. This is the first stage in the pipeline
 * lifecycle and does NOT dispatch to Daytona -- it only persists the
 * initial pipeline state.
 *
 * @see D-03 Pipeline triggered by SQS job message
 * @see D-14 Pipeline-level state in pipeline_runs table
 */

import type { Pool } from 'pg';
import { PipelineStage, PipelineError, type StageMessage, type StageResult } from '../types.js';

// --- Intake handler ----------------------------------------------------------

/**
 * Handles the intake stage by creating the pipeline_run record.
 *
 * The stage router generates the runId via crypto.randomUUID() and passes
 * it in the StageMessage. Intake inserts the pipeline_run row using the
 * pre-generated runId. ON CONFLICT DO NOTHING ensures idempotency on replay.
 *
 * @param msg - Stage message containing runId and pipeline context
 * @param pool - Postgres connection pool
 * @returns Stage result with status 'completed' and no tasks
 * @throws {PipelineError} When the database insert fails
 *
 * @example
 * const result = await handleIntakeStage(stageMessage, pool);
 * // result.status === 'completed'
 */
export async function handleIntakeStage(
  msg: StageMessage,
  pool: Pool,
): Promise<StageResult> {
  const sql = `
    INSERT INTO pipeline_runs (id, project_id, phase_total, config, status, repo_url, branch, feature_description)
    VALUES ($1::uuid, $2, $3, $4, 'running', $5, $6, $7)
    ON CONFLICT (id) DO NOTHING
  `;

  try {
    await pool.query(sql, [
      msg.runId,
      msg.projectId,
      msg.context.phaseTotal,
      JSON.stringify({ featureDescription: msg.context.featureDescription }),
      msg.repoUrl,
      msg.branch,
      msg.context.featureDescription,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to insert pipeline run: ${message}`,
      'handleIntakeStage',
      PipelineStage.Intake,
    );
  }

  return { stage: PipelineStage.Intake, status: 'completed', tasks: [] };
}

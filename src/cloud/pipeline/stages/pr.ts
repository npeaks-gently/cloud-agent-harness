/**
 * PR stage handler for pull request creation.
 *
 * Placeholder for Phase 3 git integration (INTG-02). In v1, this
 * stage logs completion and returns success without creating an
 * actual pull request. Phase 3 will implement git operations to
 * create a PR from accumulated artifacts.
 *
 * @see D-09 Full lifecycle: research -> plan -> approve -> execute -> verify -> PR
 */

import type { Pool } from 'pg';
import { PipelineStage, type StageMessage, type StageResult } from '../types.js';

// --- PR handler --------------------------------------------------------------

/**
 * Handles the PR stage by recording pipeline completion.
 *
 * This is the terminal stage in the pipeline lifecycle. In v1, it is
 * a placeholder that logs completion. Phase 3 (INTG-02) will implement
 * actual PR creation using git operations on the accumulated artifacts.
 *
 * @param msg - Stage message with pipeline context
 * @param _pool - Postgres connection pool (unused in placeholder)
 * @returns Stage result with status 'completed' and no tasks
 *
 * @example
 * const result = await handlePrStage(stageMessage, pool);
 * // result.status === 'completed' (placeholder)
 */
export async function handlePrStage(
  msg: StageMessage,
  _pool: Pool,
): Promise<StageResult> {
  // Placeholder for Phase 3 INTG-02: PR creation from accumulated artifacts
  console.log(JSON.stringify({
    level: 'info',
    message: 'PR stage placeholder -- no PR created in v1',
    runId: msg.runId,
    projectId: msg.projectId,
    stage: PipelineStage.PR,
  }));

  return { stage: PipelineStage.PR, status: 'completed', tasks: [] };
}

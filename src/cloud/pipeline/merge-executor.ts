/**
 * Merge executor for combining task branches into the feature branch.
 *
 * Sequentially merges task branches into the feature branch using
 * git merge --no-ff. On conflict, aborts the merge and throws a
 * MergeError with the conflicting branch name.
 *
 * @see D-07 Branch merge strategy for task branches
 * @see T-03-12 Branch names are pipeline-generated (no shell metacharacters)
 */

import { execSync } from 'node:child_process';

// --- Error -------------------------------------------------------------------

/**
 * Error thrown when a git merge operation fails.
 * Includes the operation name and optionally the conflicting branch.
 */
export class MergeError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly branch?: string,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

// --- Merge executor ----------------------------------------------------------

/**
 * Merges task branches into the feature branch in order.
 *
 * Checks out the feature branch, then sequentially merges each task
 * branch using --no-ff (creates a merge commit for each). If any merge
 * fails (e.g., conflict), the merge is aborted and a MergeError is thrown.
 *
 * @param workDir - Git working directory
 * @param featureBranch - Target branch to merge into
 * @param taskBranches - Ordered list of task branch names to merge
 * @returns List of successfully merged branches
 * @throws {MergeError} On merge conflict or git failure
 *
 * @example
 * const merged = await mergeTaskBranches('/repo', 'cah/abc/feature', ['task-1', 'task-2']);
 * // merged === ['task-1', 'task-2']
 */
export async function mergeTaskBranches(
  workDir: string,
  featureBranch: string,
  taskBranches: string[],
): Promise<string[]> {
  const merged: string[] = [];

  // Checkout feature branch
  execSync(`git checkout ${featureBranch}`, { cwd: workDir, encoding: 'utf-8' });

  for (const branch of taskBranches) {
    try {
      execSync(`git merge ${branch} --no-ff -m "Merge ${branch} into ${featureBranch}"`, {
        cwd: workDir,
        encoding: 'utf-8',
      });
      merged.push(branch);

      console.log(JSON.stringify({
        level: 'info',
        message: 'Task branch merged successfully',
        branch,
        featureBranch,
      }));
    } catch (err) {
      // Abort failed merge
      try {
        execSync('git merge --abort', { cwd: workDir });
      } catch {
        /* already clean */
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new MergeError(
        `Merge conflict on branch ${branch}: ${message}`,
        'mergeTaskBranches',
        branch,
      );
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'All task branches merged',
    mergedCount: merged.length,
    featureBranch,
  }));

  return merged;
}

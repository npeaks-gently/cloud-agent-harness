/**
 * PR stage handler for pull request creation.
 *
 * Creates a pull request on GitHub from the feature branch to the base
 * branch, attaches the PR URL to the Linear parent ticket, and marks
 * the ticket as done.
 *
 * @see D-08 PR from feature branch to main
 * @see D-11 PR URL linked to parent ticket on completion
 * @see T-03-14 PR creation tracked in PostHog and linked to Linear
 */

import type { Pool } from 'pg';
import { PipelineStage, PipelineError, type StageMessage, type StageResult } from '../types.js';
import { createPullRequest } from '../../integrations/github.js';
import { attachPrUrl, updateTicketStatus } from '../../integrations/linear.js';
import { track } from '../../analytics.js';

// --- Helpers -----------------------------------------------------------------

/**
 * Parses a GitHub repository URL into owner and repo components.
 *
 * Handles both full URLs (https://github.com/owner/repo) and
 * shorthand format (owner/repo). Strips trailing .git if present.
 *
 * @param url - Repository URL or owner/repo string
 * @returns Object with owner and repo strings
 * @throws {PipelineError} When the URL cannot be parsed
 */
function parseRepoUrl(url: string): { owner: string; repo: string } {
  const cleaned = url.replace(/\.git$/, '');

  const urlMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  const shortMatch = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  throw new PipelineError(
    `Cannot parse repository URL: ${url}`,
    'handlePrStage',
    PipelineStage.PR,
  );
}

// --- PR handler --------------------------------------------------------------

/**
 * Handles the PR stage by creating a pull request on GitHub.
 *
 * This is the terminal stage in the pipeline lifecycle. It creates a PR
 * from the feature branch to the base branch, attaches the PR URL to the
 * Linear parent ticket (if present), and marks the ticket as done.
 *
 * @param msg - Stage message with pipeline context
 * @param _pool - Postgres connection pool (unused in PR stage)
 * @returns Stage result with status 'completed' and no tasks
 * @throws {PipelineError} When featureBranch is missing or PR creation fails
 *
 * @example
 * const result = await handlePrStage(stageMessage, pool);
 * // result.status === 'completed'
 */
export async function handlePrStage(
  msg: StageMessage,
  _pool: Pool,
): Promise<StageResult> {
  // Step 1: Validate feature branch
  const featureBranch = msg.context.featureBranch;
  if (!featureBranch) {
    throw new PipelineError(
      'Feature branch is required for PR creation but not found in context',
      'handlePrStage',
      PipelineStage.PR,
    );
  }

  // Step 2: Parse owner/repo from repoUrl
  const { owner, repo } = parseRepoUrl(msg.repoUrl);

  // Step 3: Build PR title and body (D-08)
  const title = `[CAH] ${msg.context.featureDescription}`;
  const body = [
    '## Pipeline Run',
    '',
    `- **Run ID:** ${msg.runId}`,
    `- **Project:** ${msg.projectId}`,
    `- **Phases:** ${msg.context.phaseNumber}/${msg.context.phaseTotal}`,
    '',
    '## Summary',
    '',
    msg.context.featureDescription,
    '',
    '---',
    '*Automated by Cloud Agent Harness*',
  ].join('\n');

  // Step 4: Create pull request on GitHub
  let pr: { url: string; number: number };
  try {
    pr = await createPullRequest(owner, repo, featureBranch, msg.branch, title, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      `Failed to create pull request: ${message}`,
      'handlePrStage',
      PipelineStage.PR,
    );
  }

  // Step 5: Link PR to Linear ticket if present (D-11)
  if (msg.context.linearParentTicketId) {
    try {
      await attachPrUrl(msg.context.linearParentTicketId, pr.url);
    } catch (err) {
      console.log(JSON.stringify({
        level: 'warn',
        message: 'Failed to attach PR URL to Linear ticket',
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    try {
      await updateTicketStatus(msg.context.linearParentTicketId, 'done');
    } catch (err) {
      console.log(JSON.stringify({
        level: 'warn',
        message: 'Failed to update Linear ticket status to done',
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Step 6: Track PR creation event (D-14, T-03-14)
  track('pr_created', {
    runId: msg.runId,
    projectId: msg.projectId,
    prUrl: pr.url,
    prNumber: pr.number,
  });

  // Step 7: CloudWatch log
  console.log(JSON.stringify({
    level: 'info',
    message: 'Pull request created',
    runId: msg.runId,
    projectId: msg.projectId,
    prUrl: pr.url,
    prNumber: pr.number,
  }));

  return { stage: PipelineStage.PR, status: 'completed', tasks: [] };
}

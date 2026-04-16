/**
 * Shared utilities for pipeline stage handlers.
 *
 * Extracted to avoid duplication across stage implementations.
 */

import { PipelineError, PipelineStage } from './types.js';

/**
 * Parses a GitHub repository URL into owner and repo components.
 *
 * Handles both full URLs (https://github.com/owner/repo) and
 * shorthand format (owner/repo). Strips trailing .git if present.
 *
 * @param url - Repository URL or owner/repo string
 * @param callerOperation - Name of the calling operation (for error context, defaults to 'parseRepoUrl')
 * @param callerStage - Pipeline stage of the caller (for error context)
 * @returns Object with owner and repo strings
 * @throws {PipelineError} When the URL cannot be parsed
 */
export function parseRepoUrl(
  url: string,
  callerOperation?: string,
  callerStage?: PipelineStage,
): { owner: string; repo: string } {
  // Strip trailing .git
  const cleaned = url.replace(/\.git$/, '');

  // Try full URL: https://github.com/owner/repo
  const urlMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  // Try shorthand: owner/repo
  const shortMatch = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  throw new PipelineError(
    `Cannot parse repository URL: ${url}`,
    callerOperation ?? 'parseRepoUrl',
    callerStage,
  );
}

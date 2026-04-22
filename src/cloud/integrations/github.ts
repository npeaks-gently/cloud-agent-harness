/**
 * GitHub REST API wrapper for branch and pull request management.
 *
 * Wraps @octokit/rest to create feature branches and open pull requests.
 * GitHub PAT is fetched from Secrets Manager and cached at Lambda cold start.
 *
 * @see D-05 Feature branch created at intake stage
 * @see D-08 PR from feature branch to main
 */

import { Octokit } from '@octokit/rest';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by GitHub integration operations.
 * Includes the operation that failed and optionally the target repository.
 */
export class GitHubClientError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly repo?: string,
  ) {
    super(message);
    this.name = 'GitHubClientError';
  }
}

// ─── Secrets ────────────────────────────────────────────────────────────────

/** Cached GitHub PAT resolved from Secrets Manager at Lambda cold start. */
let cachedGitHubToken: string | undefined;

/**
 * Fetches the GitHub PAT from Secrets Manager and caches it.
 *
 * The secret ARN is provided via CAH_GITHUB_TOKEN_SECRET_ARN env var
 * (set by the pipeline CDK construct). The value is cached in module
 * scope so subsequent invocations reuse it within the same Lambda
 * execution context.
 *
 * @returns The resolved GitHub token string
 * @throws Error if CAH_GITHUB_TOKEN_SECRET_ARN is not set or secret fetch fails
 */
export async function getGitHubToken(): Promise<string> {
  if (cachedGitHubToken) return cachedGitHubToken;
  const secretArn = process.env.CAH_GITHUB_TOKEN_SECRET_ARN;
  if (!secretArn) throw new Error('CAH_GITHUB_TOKEN_SECRET_ARN not set');
  const smClient = new SecretsManagerClient({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  });
  const response = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) {
    throw new Error('Secrets Manager returned empty SecretString');
  }
  cachedGitHubToken = response.SecretString;
  return cachedGitHubToken;
}

/**
 * Resets the cached GitHub token. Intended for testing only.
 * @internal
 */
export function _resetTokenCache(): void {
  cachedGitHubToken = undefined;
}

// ─── Branch ─────────────────────────────────────────────────────────────────

/**
 * Creates a feature branch from a base branch on GitHub.
 *
 * Fetches the HEAD SHA of the base branch and creates a new ref pointing
 * to the same commit (D-05: feature branch created at intake stage).
 *
 * @param owner - Repository owner (user or organization)
 * @param repo - Repository name
 * @param branchName - Name for the new branch (without refs/heads/ prefix)
 * @param baseBranch - Name of the branch to fork from
 * @throws {GitHubClientError} When the GitHub API call fails
 */
export async function createFeatureBranch(
  owner: string,
  repo: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  const token = await getGitHubToken();
  const octokit = new Octokit({ auth: token });

  try {
    const baseRef = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });

    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.data.object.sha,
    });

    console.log(JSON.stringify({
      level: 'info',
      message: 'Feature branch created',
      branchName,
      repo: `${owner}/${repo}`,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitHubClientError(
      `Failed to create feature branch: ${message}`,
      'createFeatureBranch',
      `${owner}/${repo}`,
    );
  }
}

// ─── Pull Request ───────────────────────────────────────────────────────────

/**
 * Creates a pull request on GitHub.
 *
 * Opens a PR from the head branch to the base branch with a structured
 * title and body (D-08: PR from feature branch to main).
 *
 * @param owner - Repository owner (user or organization)
 * @param repo - Repository name
 * @param head - Source branch name
 * @param base - Target branch name
 * @param title - Pull request title
 * @param body - Pull request description (markdown)
 * @returns Object with the PR URL and number
 * @throws {GitHubClientError} When the GitHub API call fails
 */
export async function createPullRequest(
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number }> {
  const token = await getGitHubToken();
  const octokit = new Octokit({ auth: token });

  try {
    const { data } = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head,
      base,
    });

    console.log(JSON.stringify({
      level: 'info',
      message: 'Pull request created',
      url: data.html_url,
      number: data.number,
    }));

    return { url: data.html_url, number: data.number };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitHubClientError(
      `Failed to create pull request: ${message}`,
      'createPullRequest',
      `${owner}/${repo}`,
    );
  }
}

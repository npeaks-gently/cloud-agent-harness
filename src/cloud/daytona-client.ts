/**
 * Daytona SDK wrapper for sandbox lifecycle management.
 *
 * Wraps the @daytonaio/sdk to provide a focused interface for
 * creating sandboxes, cloning repos, executing commands, and
 * tearing down sandboxes with guaranteed cleanup.
 */

import { Daytona, type CreateSandboxFromSnapshotParams } from '@daytonaio/sdk';
import type { AgentTaskConfig, AgentTaskResult } from './types.js';
import { getSnapshotName } from './snapshot/snapshot-manager.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_CPU = 2;
const DEFAULT_MEMORY = 4;
const WORKSPACE_DIR = '/home/daytona/workspace';

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by Daytona sandbox operations.
 * Includes the operation that failed and optionally the sandbox ID.
 */
export class DaytonaClientError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly sandboxId?: string,
  ) {
    super(message);
    this.name = 'DaytonaClientError';
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

/**
 * Manages Daytona sandbox lifecycle for agent task execution.
 *
 * Each `executeTask` call creates a fresh sandbox, clones the target repo,
 * executes a command, and tears down the sandbox -- guaranteeing cleanup
 * even on failure (per D-07: workspaces torn down immediately after completion).
 *
 * @example
 * ```typescript
 * const client = new DaytonaClient({ apiKey: 'dtn_xxx' });
 * const result = await client.executeTask({
 *   repoUrl: 'https://github.com/org/repo.git',
 *   branch: 'main',
 *   envVars: { NODE_ENV: 'production' },
 *   command: 'npm test',
 * });
 * console.log(`Exit code: ${result.exitCode}`);
 * ```
 */
export class DaytonaClient {
  private readonly daytona: Daytona;

  constructor(opts: {
    apiKey: string;
    target?: string;
  }) {
    this.daytona = new Daytona({
      apiKey: opts.apiKey,
      target: opts.target,
    });
  }

  /**
   * Executes a task inside an isolated Daytona sandbox.
   *
   * 1. Creates a sandbox with specified env vars and resources
   * 2. Clones the target repository
   * 3. Executes the command
   * 4. Returns the result
   * 5. Always deletes the sandbox in a finally block (D-07, Pitfall 1)
   *
   * @param config - Task configuration including repo, branch, command, and env vars
   * @returns Task execution result with exit code, stdout, and duration
   * @throws {DaytonaClientError} When any sandbox operation fails
   */
  async executeTask(config: AgentTaskConfig): Promise<AgentTaskResult> {
    let sandboxId: string | undefined;
    const startMs = Date.now();

    try {
      // Step 1: Create sandbox with environment variables and resources
      const createParams: CreateSandboxFromSnapshotParams = {
        language: 'typescript',
        snapshot: getSnapshotName(),
        envVars: config.envVars,
      };

      const sandbox = await this.daytona.create(createParams);
      sandboxId = sandbox.id;

      // Step 2: Clone the target repository
      await sandbox.git.clone(config.repoUrl, WORKSPACE_DIR, config.branch);

      // Step 3: Execute the command
      const timeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const response = await sandbox.process.executeCommand(
        config.command,
        WORKSPACE_DIR,
        config.envVars,
        timeout,
      );

      const durationMs = Date.now() - startMs;

      return {
        exitCode: response.exitCode,
        stdout: response.result,
        durationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DaytonaClientError(
        `Sandbox operation failed: ${message}`,
        sandboxId ? 'execute' : 'create',
        sandboxId,
      );
    } finally {
      // Step 5: Always clean up the sandbox (D-07, Pitfall 1)
      if (sandboxId) {
        try {
          const sandbox = await this.daytona.get(sandboxId);
          await sandbox.delete();
        } catch {
          // Best-effort cleanup -- sandbox may already be gone
        }
      }
    }
  }
}

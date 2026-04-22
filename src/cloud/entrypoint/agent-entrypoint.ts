#!/usr/bin/env node

/**
 * Agent entrypoint script for Daytona sandbox execution.
 *
 * Baked into the Daytona sandbox image, this script:
 * 1. Reads task config from CAH_* environment variables
 * 2. Downloads .planning/ context from S3
 * 3. Runs the agent via the SDK (stage-dependent)
 * 4. Finds modified files via git diff
 * 5. Uploads modified files to S3
 * 6. Writes JSON result to stdout for the orchestrator
 *
 * Per D-07, D-16, D-17.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { execSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { track, flush } from '../analytics.js';
import { downloadPlanningDir, uploadModifiedFiles } from './s3-sync.js';
import { loadSdk } from './sdk-loader.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default workspace directory inside Daytona sandbox. */
const WORK_DIR = '/home/daytona/workspace';

/** Default AWS region per D-11. */
const DEFAULT_REGION = 'us-east-1';

// ─── Env validation ─────────────────────────────────────────────────────────

/**
 * Reads a required environment variable, throwing if not set.
 *
 * @param name - Environment variable name
 * @returns The environment variable value
 * @throws Error if the variable is not set or empty
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

// ─── Modified file detection ────────────────────────────────────────────────

/**
 * Finds modified and newly created files using git status.
 *
 * Uses `git status --porcelain` to capture both tracked modifications and
 * untracked new files (which `git diff --name-only HEAD` would miss).
 * Reads each file and returns path/content pairs suitable for
 * uploadModifiedFiles(). Only includes files that exist and can be read.
 *
 * @param workDir - Working directory to detect changes in
 * @returns Array of file objects with relative path and content buffer
 */
async function findModifiedFiles(
  workDir: string,
): Promise<Array<{ path: string; content: Buffer }>> {
  const output = execSync('git status --porcelain', {
    cwd: workDir,
    encoding: 'buffer',
  });

  const filePaths = output
    .toString('utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('D ') && !line.startsWith(' D'))
    .map((line) => line.replace(/^[?! MADRCU]{1,2}\s+/, ''));

  const files: Array<{ path: string; content: Buffer }> = [];

  for (const filePath of filePaths) {
    try {
      const content = await readFile(join(workDir, filePath));
      files.push({ path: filePath, content: Buffer.from(content) });
    } catch {
      // File may have been deleted -- skip
    }
  }

  return files;
}

// ─── Git operations ────────────────────────────────────────────────────────

/**
 * Configures git credentials using the CAH_GITHUB_TOKEN env var.
 * Uses a credential helper to provide credentials without storing them in
 * git config files (T-03-15).
 *
 * @param workDir - Working directory
 * @param token - GitHub token for HTTPS authentication
 */
function configureGitAuth(workDir: string, token: string): void {
  execSync(
    `git config credential.helper '!f() { echo "password=${token}"; }; f'`,
    { cwd: workDir, encoding: 'utf-8' },
  );
  execSync('git config user.email "cah-bot@cloud-agent-harness.dev"', {
    cwd: workDir,
    encoding: 'utf-8',
  });
  execSync('git config user.name "Cloud Agent Harness"', {
    cwd: workDir,
    encoding: 'utf-8',
  });
}

/**
 * Creates a task-specific branch for the current agent task.
 * Branch name format: cah/{runId}/{phase}-{plan}-{wave} per D-06.
 *
 * Branch name components (runId=UUID, phase=numeric, plan=alphanumeric,
 * wave=numeric) contain no user-controlled input (T-03-19).
 *
 * @param workDir - Working directory
 * @param featureBranch - Feature branch to base off
 * @param runId - Pipeline run ID
 * @param phase - Phase number
 * @param plan - Plan name
 * @param wave - Wave number (defaults to '1')
 * @returns The created branch name
 */
function createTaskBranch(
  workDir: string,
  featureBranch: string,
  runId: string,
  phase: string,
  plan: string,
  wave: string,
): string {
  const branchName = `cah/${runId}/${phase}-${plan}-${wave}`;
  const fetchResult = spawnSync('git', ['fetch', 'origin', featureBranch], {
    cwd: workDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (fetchResult.status !== 0) {
    throw new Error(`git fetch failed: ${String(fetchResult.stderr)}`);
  }
  const checkoutResult = spawnSync('git', ['checkout', '-b', branchName, `origin/${featureBranch}`], {
    cwd: workDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (checkoutResult.status !== 0) {
    throw new Error(`git checkout failed: ${String(checkoutResult.stderr)}`);
  }
  return branchName;
}

/**
 * Commits all changes and pushes the task branch to remote.
 *
 * @param workDir - Working directory
 * @param taskBranch - Branch name to push
 * @param commitMessage - Commit message
 */
function commitAndPush(
  workDir: string,
  taskBranch: string,
  commitMessage: string,
): void {
  execSync('git add -A', { cwd: workDir, encoding: 'utf-8' });
  // Check if there are changes to commit
  const status = execSync('git status --porcelain', {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();
  if (status.length > 0) {
    const commitResult = spawnSync('git', ['commit', '-m', commitMessage], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (commitResult.status !== 0) {
      throw new Error(`git commit failed: ${String(commitResult.stderr)}`);
    }
  }
  const pushResult = spawnSync('git', ['push', 'origin', taskBranch], {
    cwd: workDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (pushResult.status !== 0) {
    throw new Error(`git push failed: ${String(pushResult.stderr)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Sandbox entrypoint: download context, run agent, upload artifacts.
 *
 * Reads CAH_* environment variables for task configuration, downloads
 * .planning/ from S3, runs the agent session via the SDK based on stage,
 * uploads modified files, and writes a JSON result to stdout.
 *
 * @throws Error if required env vars are missing or if an unknown stage is specified
 */
export async function main(): Promise<void> {
  const runId = requireEnv('CAH_RUN_ID');
  const stage = requireEnv('CAH_STAGE');
  const phase = process.env.CAH_PHASE ?? '01';
  const plan = process.env.CAH_PLAN ?? '';
  const bucket = requireEnv('CAH_BUCKET');
  const featureBranch = process.env.CAH_FEATURE_BRANCH ?? '';
  const wave = process.env.CAH_WAVE ?? '1';
  const githubToken = process.env.CAH_GITHUB_TOKEN ?? '';
  const startMs = Date.now();

  const s3 = new S3Client({ region: DEFAULT_REGION });

  // Step 1: Download .planning/ context from S3
  await downloadPlanningDir(bucket, runId, WORK_DIR, s3);

  // Step 2: Run agent based on stage
  let success = true;
  let costUsd = 0;

  switch (stage) {
    case 'research':
    case 'plan':
    case 'verify': {
      const { GSD } = await loadSdk();
      const gsd = new GSD({ projectDir: WORK_DIR, autoMode: true });
      const result = await gsd.runPhase(phase);
      success = result.success;
      costUsd = result.totalCostUsd ?? 0;
      break;
    }
    case 'execute': {
      let taskBranch = '';

      // Phase 3 D-06: Create task branch and configure git auth if feature branch is set
      if (featureBranch && githubToken) {
        configureGitAuth(WORK_DIR, githubToken);
        taskBranch = createTaskBranch(WORK_DIR, featureBranch, runId, phase, plan, wave);
      }

      const { GSD } = await loadSdk();
      const gsd = new GSD({ projectDir: WORK_DIR, autoMode: true });
      const result = await gsd.executePlan(plan);
      success = result.success;
      costUsd = result.totalCostUsd ?? 0;
      const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

      // Phase 3 D-14 / INTG-04 SC-4: Track agent run completion with cost and token usage data
      track('agent_run_completed', {
        runId,
        phase,
        plan,
        wave,
        costUsd,
        success,
        projectId: process.env.CAH_PROJECT_ID ?? '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
      });

      // Phase 3 D-06: Commit and push task branch
      if (taskBranch && success) {
        commitAndPush(WORK_DIR, taskBranch, `feat(${phase}-${plan}): agent task execution`);
      }

      // Flush PostHog events before handler exit to prevent event loss in Lambda
      await flush();

      break;
    }
    case 'approve':
      // Auto-approve per D-10 -- no-op in sandbox
      break;
    case 'pr':
      // PR creation handled in Phase 3 (INTG-02)
      break;
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }

  // Step 3: Upload modified files
  const modifiedFiles = await findModifiedFiles(WORK_DIR);
  const artifacts = await uploadModifiedFiles(bucket, runId, phase, modifiedFiles, s3);

  // Step 4: Write result to stdout
  const durationMs = Date.now() - startMs;
  console.log(JSON.stringify({ success, costUsd, durationMs, artifacts }));
}

// ─── Top-level invocation ───────────────────────────────────────────────────

// Only auto-run when executed directly, not when imported in tests.
const isMainModule = process.argv[1]?.endsWith('agent-entrypoint.js')
  || process.argv[1]?.endsWith('agent-entrypoint.ts')
  || process.argv[1]?.endsWith('/harness/entrypoint.js');

if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

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

// ─── Types (local, to avoid pulling the SDK types through the bundler) ──────

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface PlanResultLike {
  usage?: SessionUsage;
}

interface PhaseStepLike {
  planResults?: PlanResultLike[];
}

interface PhaseResultLike {
  steps?: PhaseStepLike[];
}

// ─── Usage aggregation ──────────────────────────────────────────────────────

/**
 * Sums token usage across every plan result in every phase step.
 *
 * `PhaseRunnerResult` does not expose an aggregate usage field — cost is
 * rolled up but tokens live on each `PlanResult.usage`. For pipeline
 * checkpoints we need a single number per dimension, so walk the tree.
 */
function aggregatePhaseUsage(result: PhaseResultLike): SessionUsage {
  const totals: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const step of result.steps ?? []) {
    for (const pr of step.planResults ?? []) {
      if (!pr.usage) continue;
      totals.inputTokens += pr.usage.inputTokens ?? 0;
      totals.outputTokens += pr.usage.outputTokens ?? 0;
      totals.cacheReadInputTokens += pr.usage.cacheReadInputTokens ?? 0;
      totals.cacheCreationInputTokens += pr.usage.cacheCreationInputTokens ?? 0;
    }
  }
  return totals;
}

/**
 * Maps a config `model_profile` to a concrete model ID.
 * Duplicates the SDK's internal `resolveModel` mapping (session-runner.ts)
 * so the entrypoint can report the model without spinning up a runner.
 */
function modelIdFromProfile(profile: string | undefined): string | undefined {
  if (!profile) return undefined;
  const map: Record<string, string> = {
    balanced: 'claude-sonnet-4-6',
    quality: 'claude-opus-4-6',
    speed: 'claude-haiku-4-5',
  };
  return map[profile] ?? profile;
}

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
  // Both username and password are required by git's credential protocol.
  // GitHub PATs use any non-empty username with the token as password.
  execSync(
    `git config credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
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
  // Daytona's git.clone fetches only the target branch and may not populate
  // refs/remotes/origin/<other-branch>. Use the explicit refspec form so the
  // remote-tracking ref is always created, then check out from it.
  const refspec = `${featureBranch}:refs/remotes/origin/${featureBranch}`;
  const fetchResult = spawnSync('git', ['fetch', 'origin', refspec], {
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
  let usage: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let model: string | undefined;

  switch (stage) {
    case 'research':
    case 'plan':
    case 'verify': {
      const sdk = await loadSdk();
      const { GSD, loadConfig } = sdk;
      // Derive model from project config (the SDK resolves it the same way
      // internally but does not surface it on the phase result).
      try {
        const config = await loadConfig(WORK_DIR);
        model = modelIdFromProfile(config.model_profile);
      } catch {
        // Missing/invalid config is not fatal for reporting; leave model undefined.
      }
      const gsd = new GSD({ projectDir: WORK_DIR, autoMode: true });
      const result = await gsd.runPhase(phase);
      success = result.success;
      costUsd = result.totalCostUsd ?? 0;
      usage = aggregatePhaseUsage(result as PhaseResultLike);
      track('agent_run_completed', {
        runId,
        phase,
        plan,
        wave,
        stage,
        costUsd,
        success,
        projectId: process.env.CAH_PROJECT_ID ?? '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        model: model ?? '',
      });
      if (!success) {
        // Surface the per-step failure detail to stderr so the orchestrator
        // can capture it. The aggregate result.success collapses N step
        // outcomes into a single bool, dropping the actual reason.
        const steps = (result as { steps?: Array<{ step: string; success: boolean; error?: string; durationMs?: number }> }).steps ?? [];
        const failedSteps = steps.filter((s) => !s.success);
        console.error(JSON.stringify({
          level: 'error',
          message: 'gsd.runPhase returned failure',
          phase,
          stage,
          totalDurationMs: (result as { totalDurationMs?: number }).totalDurationMs,
          failedSteps: failedSteps.map((s) => ({
            step: s.step,
            durationMs: s.durationMs,
            error: s.error,
          })),
          allStepStatuses: steps.map((s) => `${s.step}:${s.success ? 'ok' : 'fail'}`),
        }));
      }
      break;
    }
    case 'execute': {
      // Configure git + create task branch up front so any files written by
      // the phase-runner land on the right branch.
      let taskBranch = '';
      if (featureBranch && githubToken) {
        configureGitAuth(WORK_DIR, githubToken);
        taskBranch = createTaskBranch(WORK_DIR, featureBranch, runId, phase, plan, wave);
      }

      const { GSD, loadConfig } = await loadSdk();
      try {
        const cfg = await loadConfig(WORK_DIR);
        model = modelIdFromProfile(cfg.model_profile);
      } catch {
        // Missing/invalid config is not fatal for reporting.
      }
      // Drive the phase via runPhase like research/plan/verify. GSD's state
      // machine resumes from the next pending step (execute) based on STATE.md.
      // The earlier idea of executePlan(planId) doesn't match the SDK — that
      // API expects a plan file PATH, which the cloud orchestrator doesn't
      // know without scanning .planning/.
      const gsd = new GSD({ projectDir: WORK_DIR, autoMode: true });
      const result = await gsd.runPhase(phase);
      success = result.success;
      costUsd = result.totalCostUsd ?? 0;
      usage = aggregatePhaseUsage(result as PhaseResultLike);

      track('agent_run_completed', {
        runId,
        phase,
        plan,
        wave,
        stage,
        costUsd,
        success,
        projectId: process.env.CAH_PROJECT_ID ?? '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        model: model ?? '',
      });

      if (!success) {
        const steps = (result as { steps?: Array<{ step: string; success: boolean; error?: string; durationMs?: number }> }).steps ?? [];
        const failedSteps = steps.filter((s) => !s.success);
        console.error(JSON.stringify({
          level: 'error',
          message: 'gsd.runPhase returned failure',
          phase,
          stage,
          totalDurationMs: (result as { totalDurationMs?: number }).totalDurationMs,
          failedSteps: failedSteps.map((s) => ({
            step: s.step,
            durationMs: s.durationMs,
            error: s.error,
          })),
          allStepStatuses: steps.map((s) => `${s.step}:${s.success ? 'ok' : 'fail'}`),
        }));
      }

      // Push whatever the phase wrote, even on partial success — failed
      // verification still leaves usable code that we want to inspect.
      if (taskBranch) {
        try {
          commitAndPush(WORK_DIR, taskBranch, `feat(${phase}-${plan}): cah phase execute`);
        } catch (err) {
          console.error(JSON.stringify({
            level: 'warn',
            message: 'commitAndPush failed',
            taskBranch,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }

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
  console.log(JSON.stringify({ success, costUsd, durationMs, artifacts, usage, model }));
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

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
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
 * Finds files modified since the last commit using git diff.
 *
 * Reads each modified file and returns path/content pairs suitable
 * for uploadModifiedFiles(). Only includes files that exist and can be read.
 *
 * @param workDir - Working directory to detect changes in
 * @returns Array of file objects with relative path and content buffer
 */
async function findModifiedFiles(
  workDir: string,
): Promise<Array<{ path: string; content: Buffer }>> {
  const output = execSync('git diff --name-only HEAD', {
    cwd: workDir,
    encoding: 'buffer',
  });

  const filePaths = output
    .toString('utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

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
      const { GSD } = await loadSdk();
      const gsd = new GSD({ projectDir: WORK_DIR, autoMode: true });
      const result = await gsd.executePlan(plan);
      success = result.success;
      costUsd = result.totalCostUsd ?? 0;
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
  || process.argv[1]?.endsWith('agent-entrypoint.ts');

if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

#!/usr/bin/env tsx
/**
 * Rebuilds the entrypoint bundle and publishes the Daytona snapshot
 * referenced by src/cloud/daytona-client.ts at runtime.
 *
 * Requires DAYTONA_API_KEY in the environment (export it or source a .env
 * before running). The snapshot build executes in Daytona's infrastructure;
 * this script streams build logs to stdout. Takes several minutes because
 * the image does `npm ci --production` inside the build.
 */
import { Daytona } from '@daytonaio/sdk';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createOrUpdateSnapshot, getSnapshotName } from '../src/cloud/snapshot/snapshot-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error('DAYTONA_API_KEY is not set');
  }

  console.log('[build] compiling SDK to sdk/dist...');
  // tsc emits JS even with type errors (noEmitOnError defaults to false),
  // but npm exits non-zero. Ignore the exit code and rely on the dist
  // existence check below.
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(rootDir, 'sdk'),
      stdio: 'inherit',
    });
  } catch {
    console.warn('[build] tsc reported errors; checking dist output...');
  }

  const sdkDistPath = path.join(rootDir, 'sdk/dist/index.js');
  if (!existsSync(sdkDistPath)) {
    throw new Error(`SDK dist missing at ${sdkDistPath}`);
  }

  console.log('[build] bundling entrypoint...');
  execFileSync('node', [path.join(rootDir, 'scripts/build-entrypoint.mjs')], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  const bundlePath = path.join(rootDir, 'src/cloud/entrypoint/agent-entrypoint.js');
  if (!existsSync(bundlePath)) {
    throw new Error(`Bundle missing at ${bundlePath}`);
  }

  const snapshotName = getSnapshotName();
  console.log(`[snapshot] publishing ${snapshotName}...`);

  // Daytona SDK resolves addLocalDir paths relative to CWD, not relative
  // to image-builder.ts. Switch to the repo root so ./sdk, ./agents, etc. resolve.
  process.chdir(rootDir);

  const daytona = new Daytona({ apiKey });
  const startMs = Date.now();

  await createOrUpdateSnapshot(daytona, {
    onLogs: (log) => process.stdout.write(`[daytona] ${log}\n`),
    timeoutSeconds: 600,
  });

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[snapshot] ${snapshotName} published in ${elapsedS}s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

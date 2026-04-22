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

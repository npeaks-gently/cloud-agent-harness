#!/usr/bin/env node
/**
 * Bundles src/cloud/entrypoint/agent-entrypoint.ts into a single
 * self-contained ESM file at src/cloud/entrypoint/agent-entrypoint.js.
 *
 * Baked into the Daytona snapshot at /harness/entrypoint.js. npm packages
 * are externalized and resolved from /harness/node_modules at runtime.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const entry = path.join(rootDir, 'src/cloud/entrypoint/agent-entrypoint.ts');
const outfile = path.join(rootDir, 'src/cloud/entrypoint/agent-entrypoint.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'inline',
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

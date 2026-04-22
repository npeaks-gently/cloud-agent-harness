/**
 * Declarative Daytona Image definition for the Cloud Agent Harness runtime.
 *
 * Uses the Daytona SDK's Image.base() builder to define the sandbox
 * runtime image declaratively. The resulting image includes Node.js 22,
 * the claude-agent-sdk, GSD harness tools, agent definitions, and
 * the entrypoint script.
 *
 * @see D-05 Docker image with harness runtime baked in
 * @see D-06 Push to registry; Daytona uses as sandbox snapshot
 * @see D-07 Entrypoint script inside the image
 */

import { Image } from '@daytonaio/sdk';

// --- Image builder -----------------------------------------------------------

/**
 * Builds the Daytona Image definition for the Cloud Agent Harness runtime.
 *
 * The image is based on node:22-slim and includes:
 * - System dependencies (git, curl)
 * - SDK source code and TypeScript bindings
 * - Agent definitions and command prompts
 * - GSD harness tools (CJS CLI, workflows, templates)
 * - npm production dependencies (installed via npm ci)
 * - Entrypoint script for sandbox boot -> agent execution bridge
 *
 * @returns Daytona Image instance ready for snapshot creation
 *
 * @example
 * const image = buildHarnessImage();
 * await daytona.snapshot.create({ name: 'cah-harness-v1', image });
 */
export function buildHarnessImage(): Image {
  return Image.base('node:22-slim')
    .runCommands(
      'apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*',
    )
    .workdir('/harness')
    .addLocalDir('./sdk', '/harness/sdk')
    .addLocalDir('./agents', '/harness/agents')
    .addLocalDir('./commands', '/harness/commands')
    .addLocalDir('./get-shit-done', '/harness/get-shit-done')
    .addLocalFile('./package.json', '/harness/package.json')
    .addLocalFile('./package-lock.json', '/harness/package-lock.json')
    .runCommands('cd /harness && npm ci --production')
    .addLocalFile('./src/cloud/entrypoint/agent-entrypoint.js', '/harness/entrypoint.js')
    .env({ NODE_ENV: 'production' });
}

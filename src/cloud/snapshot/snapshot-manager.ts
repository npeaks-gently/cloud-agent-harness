/**
 * Snapshot create/verify operations via Daytona SDK.
 *
 * Manages the Daytona snapshot for the harness runtime. The snapshot
 * is the pre-configured sandbox image that all agent tasks execute
 * inside. Uses the Image definition from buildHarnessImage() and
 * registers it via the Daytona snapshot service.
 *
 * @see D-06 Daytona uses image as sandbox snapshot
 * @see D-08 Image built locally and pushed to registry
 */

import type { Daytona } from '@daytonaio/sdk';
import { buildHarnessImage } from './image-builder.js';

// --- Constants ---------------------------------------------------------------

/** Default snapshot name for the harness runtime. */
const SNAPSHOT_NAME = 'cah-harness-v1';

// --- Snapshot creation -------------------------------------------------------

/**
 * Creates or updates the Daytona snapshot for the harness runtime.
 *
 * Uses the Image definition from buildHarnessImage() and registers
 * it as a Daytona snapshot (per D-06). The snapshot name is fixed to
 * 'cah-harness-v1' -- version bumps update the same snapshot.
 *
 * Snapshot creation has a default 300-second timeout (T-02-11).
 * If the Daytona API is unresponsive, the operation fails cleanly
 * rather than hanging.
 *
 * @param daytona - Daytona SDK instance (reuse from DaytonaClient)
 * @param opts - Optional configuration
 * @param opts.name - Snapshot name override (default: 'cah-harness-v1')
 * @param opts.timeoutSeconds - Creation timeout in seconds (default: 300)
 * @param opts.onLogs - Callback for build log streaming
 *
 * @example
 * const daytona = new Daytona({ apiKey: 'dtn_xxx' });
 * await createOrUpdateSnapshot(daytona, { onLogs: console.log });
 */
export async function createOrUpdateSnapshot(
  daytona: Daytona,
  opts?: {
    name?: string;
    timeoutSeconds?: number;
    onLogs?: (log: string) => void;
  },
): Promise<void> {
  const image = buildHarnessImage();

  await daytona.snapshot.create(
    { name: opts?.name ?? SNAPSHOT_NAME, image },
    {
      onLogs: opts?.onLogs ?? console.log,
      timeout: opts?.timeoutSeconds ?? 300,
    },
  );
}

// --- Snapshot name accessor --------------------------------------------------

/**
 * Returns the snapshot name used for harness sandboxes.
 *
 * This name is passed to DaytonaClient when creating sandboxes
 * to reference the pre-built harness image.
 *
 * @returns The fixed snapshot name string
 *
 * @example
 * const snapshotName = getSnapshotName(); // 'cah-harness-v1'
 */
export function getSnapshotName(): string {
  return SNAPSHOT_NAME;
}

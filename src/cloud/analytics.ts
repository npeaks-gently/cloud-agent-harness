/**
 * PostHog analytics utility for pipeline event tracking.
 *
 * Thin wrapper per D-12: client initialization, track() helper for
 * consistent event structure, and flush() for Lambda shutdown.
 *
 * @see D-12 Thin PostHog utility
 * @see D-13 Each stage Lambda imports and calls track() directly
 * @see D-14 Event naming conventions: pipeline_started, phase_transition, etc.
 */

import { PostHog } from 'posthog-node';

// ─── Client ────────────────────────────────────────────────────────────────

let client: PostHog | undefined;

function getClient(): PostHog {
  if (!client) {
    client = new PostHog(process.env.POSTHOG_API_KEY ?? '', {
      host: 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

// ─── Track ─────────────────────────────────────────────────────────────────

/**
 * Captures an analytics event with consistent structure.
 *
 * @param event - Event name (e.g., 'pipeline_started', 'agent_run_completed')
 * @param properties - Event properties (runId, projectId, stage, etc.)
 * @param distinctId - Optional distinct ID; defaults to properties.runId or 'system'
 */
export function track(
  event: string,
  properties: Record<string, unknown>,
  distinctId?: string,
): void {
  getClient().capture({
    distinctId: distinctId ?? (properties.runId as string) ?? 'system',
    event,
    properties,
  });
}

// ─── Flush ─────────────────────────────────────────────────────────────────

/**
 * Flushes pending events and shuts down the PostHog client.
 * MUST be called before Lambda handler returns to prevent event loss.
 */
export async function flush(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = undefined;
  }
}

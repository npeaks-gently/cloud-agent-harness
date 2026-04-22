/**
 * PostHog analytics utility for pipeline event tracking.
 *
 * Thin wrapper per D-12: client initialization, track() helper for
 * consistent event structure, and flush() for Lambda shutdown.
 *
 * The PostHog API key is resolved from Secrets Manager via
 * POSTHOG_API_KEY_SECRET_ARN (consistent with other secrets).
 * Falls back to POSTHOG_API_KEY env var for local/test use.
 *
 * @see D-12 Thin PostHog utility
 * @see D-13 Each stage Lambda imports and calls track() directly
 * @see D-14 Event naming conventions: pipeline_started, phase_transition, etc.
 */

import { PostHog } from 'posthog-node';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Client ────────────────────────────────────────────────────────────────

let client: PostHog | undefined;

/** True when PostHog API key is unavailable — disables all tracking silently. */
let disabled = false;

/** Cached API key resolved from Secrets Manager at first track() call. */
let cachedApiKey: string | undefined;

/**
 * Resolves the PostHog API key from Secrets Manager or env var.
 * Caches the result for the Lambda execution lifetime.
 */
async function resolveApiKey(): Promise<string | undefined> {
  if (cachedApiKey) return cachedApiKey;

  // Try Secrets Manager first (Lambda path)
  const secretArn = process.env.POSTHOG_API_KEY_SECRET_ARN;
  if (secretArn) {
    try {
      const sm = new SecretsManagerClient({
        region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      });
      const response = await sm.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      );
      if (response.SecretString) {
        cachedApiKey = response.SecretString;
        return cachedApiKey;
      }
    } catch {
      // Fall through to env var
    }
  }

  // Fall back to plain env var (local/test)
  const envKey = process.env.POSTHOG_API_KEY;
  if (envKey) {
    cachedApiKey = envKey;
    return cachedApiKey;
  }

  return undefined;
}

async function getClient(): Promise<PostHog | undefined> {
  if (disabled) return undefined;
  if (!client) {
    const apiKey = await resolveApiKey();
    if (!apiKey) {
      disabled = true;
      return undefined;
    }
    client = new PostHog(apiKey, {
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
  // Fire and forget — resolve key async, queue event if client ready
  void getClient().then(c => {
    if (!c) return;
    c.capture({
      distinctId: distinctId ?? (properties.runId as string) ?? 'system',
      event,
      properties,
    });
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
  disabled = false;
}

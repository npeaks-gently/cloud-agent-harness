import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -------------------------------------------------------------------

const mockCapture = vi.hoisted(() => vi.fn());
const mockShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('posthog-node', () => {
  return {
    PostHog: class MockPostHog {
      capture = mockCapture;
      shutdown = mockShutdown;

      constructor(
        public apiKey: string,
        public options: Record<string, unknown>,
      ) {}
    },
  };
});

// --- Tests -------------------------------------------------------------------

describe('analytics', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCapture.mockReset();
    mockShutdown.mockReset().mockResolvedValue(undefined);

    // Reset the module-level client singleton between tests by
    // re-importing the module fresh.
    vi.resetModules();
  });

  it('track() calls capture with correct event, properties, and distinctId', async () => {
    const { track } = await import('../analytics.js');

    track('pipeline_started', { runId: 'run-1', projectId: 'proj-1' }, 'user-42');

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-42',
      event: 'pipeline_started',
      properties: { runId: 'run-1', projectId: 'proj-1' },
    });
  });

  it('track() uses properties.runId as distinctId when distinctId not provided', async () => {
    const { track } = await import('../analytics.js');

    track('agent_run_completed', { runId: 'run-99', stage: 'execute' });

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'run-99',
      event: 'agent_run_completed',
      properties: { runId: 'run-99', stage: 'execute' },
    });
  });

  it('track() uses "system" as distinctId when neither distinctId nor runId provided', async () => {
    const { track } = await import('../analytics.js');

    track('system_event', { action: 'cleanup' });

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'system',
      event: 'system_event',
      properties: { action: 'cleanup' },
    });
  });

  it('flush() calls shutdown() on the client', async () => {
    const { track, flush } = await import('../analytics.js');

    // Force client creation by calling track first
    track('test_event', { runId: 'run-1' });
    await flush();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('flush() is a no-op when client not initialized', async () => {
    const { flush } = await import('../analytics.js');

    // Flush without ever calling track -- client is undefined
    await flush();

    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('flush() resets client so next track() creates a new one', async () => {
    const { track, flush } = await import('../analytics.js');

    // First: create client and flush it
    track('event_1', { runId: 'run-1' });
    await flush();
    expect(mockShutdown).toHaveBeenCalledOnce();

    // Second: track again -- should create a fresh PostHog instance
    track('event_2', { runId: 'run-2' });
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks -------------------------------------------------------------------

const mockCapture = vi.hoisted(() => vi.fn());
const mockShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSmSend = vi.hoisted(() => vi.fn());

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

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class MockSM {
    send = mockSmSend;
  },
  GetSecretValueCommand: class MockCmd {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

// --- Helpers -----------------------------------------------------------------

/** Flush microtask queue so fire-and-forget track() promises resolve. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// --- Tests -------------------------------------------------------------------

describe('analytics', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCapture.mockReset();
    mockShutdown.mockReset().mockResolvedValue(undefined);
    mockSmSend.mockReset();
    process.env = { ...originalEnv, POSTHOG_API_KEY: 'phc_test_key' };

    // Reset the module-level client singleton between tests by
    // re-importing the module fresh.
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('track() calls capture with correct event, properties, and distinctId', async () => {
    const { track } = await import('../analytics.js');

    track('pipeline_started', { runId: 'run-1', projectId: 'proj-1' }, 'user-42');
    await tick();

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
    await tick();

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
    await tick();

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'system',
      event: 'system_event',
      properties: { action: 'cleanup' },
    });
  });

  it('flush() calls shutdown() on the client', async () => {
    const { track, flush } = await import('../analytics.js');

    track('test_event', { runId: 'run-1' });
    await tick();
    await flush();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('flush() is a no-op when client not initialized', async () => {
    const { flush } = await import('../analytics.js');

    await flush();

    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('flush() resets client so next track() creates a new one', async () => {
    const { track, flush } = await import('../analytics.js');

    track('event_1', { runId: 'run-1' });
    await tick();
    await flush();
    expect(mockShutdown).toHaveBeenCalledOnce();

    track('event_2', { runId: 'run-2' });
    await tick();
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });

  it('track() is a silent no-op when POSTHOG_API_KEY is not set', async () => {
    delete process.env.POSTHOG_API_KEY;
    const { track } = await import('../analytics.js');

    track('test_event', { runId: 'run-1' });
    await tick();

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('flush() is safe when disabled due to missing API key', async () => {
    delete process.env.POSTHOG_API_KEY;
    const { track, flush } = await import('../analytics.js');

    track('test_event', { runId: 'run-1' });
    await tick();
    await flush();

    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('resolves API key from Secrets Manager when POSTHOG_API_KEY_SECRET_ARN is set', async () => {
    delete process.env.POSTHOG_API_KEY;
    process.env.POSTHOG_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:posthog';
    mockSmSend.mockResolvedValueOnce({ SecretString: 'phc_from_sm' });

    const { track } = await import('../analytics.js');

    track('test_event', { runId: 'run-1' });
    await tick();

    expect(mockSmSend).toHaveBeenCalledOnce();
    expect(mockCapture).toHaveBeenCalledOnce();
  });
});

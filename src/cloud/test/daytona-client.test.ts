import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DaytonaClient, DaytonaClientError } from '../daytona-client.js';
import type { AgentTaskConfig } from '../types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockClone = vi.fn().mockResolvedValue(undefined);
const mockExecuteCommand = vi.fn().mockResolvedValue({
  exitCode: 0,
  result: 'success output',
});

const mockSandbox = {
  id: 'sandbox-123',
  git: { clone: mockClone },
  process: { executeCommand: mockExecuteCommand },
  delete: mockDelete,
};

const mockCreate = vi.fn().mockResolvedValue(mockSandbox);
const mockGet = vi.fn().mockResolvedValue(mockSandbox);

vi.mock('@daytonaio/sdk', () => {
  return {
    Daytona: class MockDaytona {
      constructor() {
        // Constructor is a no-op for the mock
      }
      create = mockCreate;
      get = mockGet;
    },
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AgentTaskConfig = {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'main',
  envVars: { NODE_ENV: 'test', API_KEY: 'secret' },
  command: 'npm test',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DaytonaClient', () => {
  let client: DaytonaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire mocks after clearAllMocks resets them
    mockCreate.mockResolvedValue(mockSandbox);
    mockGet.mockResolvedValue(mockSandbox);
    mockDelete.mockResolvedValue(undefined);
    mockClone.mockResolvedValue(undefined);
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      result: 'success output',
    });
    client = new DaytonaClient({ apiKey: 'test-api-key', target: 'us' });
  });

  // ─── Successful execution ───────────────────────────────────────────────

  it('creates sandbox, clones repo, executes command, and deletes sandbox', async () => {
    await client.executeTask(DEFAULT_CONFIG);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockClone).toHaveBeenCalledWith(
      'https://github.com/org/repo.git',
      '/home/daytona/workspace',
      'main',
    );
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'npm test',
      '/home/daytona/workspace',
      { NODE_ENV: 'test', API_KEY: 'secret' },
      300,
    );
    // Sandbox should be deleted via get + delete in finally
    expect(mockGet).toHaveBeenCalledWith('sandbox-123');
    expect(mockDelete).toHaveBeenCalledOnce();
  });

  it('returns correct exitCode and stdout from command execution', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 42,
      result: 'custom output',
    });

    const result = await client.executeTask(DEFAULT_CONFIG);

    expect(result.exitCode).toBe(42);
    expect(result.stdout).toBe('custom output');
  });

  it('measures duration in milliseconds', async () => {
    const result = await client.executeTask(DEFAULT_CONFIG);

    expect(result.durationMs).toBeTypeOf('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Cleanup guarantee ─────────────────────────────────────────────────

  it('deletes sandbox even when command execution fails (finally block)', async () => {
    mockExecuteCommand.mockRejectedValueOnce(new Error('Command timed out'));

    await expect(client.executeTask(DEFAULT_CONFIG)).rejects.toThrow(DaytonaClientError);

    // Sandbox must still be cleaned up
    expect(mockGet).toHaveBeenCalledWith('sandbox-123');
    expect(mockDelete).toHaveBeenCalledOnce();
  });

  // ─── Error handling ───────────────────────────────────────────────────

  it('throws DaytonaClientError with operation "create" on create failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API key invalid'));

    try {
      await client.executeTask(DEFAULT_CONFIG);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaytonaClientError);
      const clientErr = err as DaytonaClientError;
      expect(clientErr.operation).toBe('create');
      expect(clientErr.sandboxId).toBeUndefined();
      expect(clientErr.message).toContain('API key invalid');
    }
  });

  it('throws DaytonaClientError with sandbox ID on execute failure', async () => {
    mockExecuteCommand.mockRejectedValueOnce(new Error('Process killed'));

    try {
      await client.executeTask(DEFAULT_CONFIG);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaytonaClientError);
      const clientErr = err as DaytonaClientError;
      expect(clientErr.operation).toBe('execute');
      expect(clientErr.sandboxId).toBe('sandbox-123');
      expect(clientErr.message).toContain('Process killed');
    }
  });

  // ─── Custom timeout ───────────────────────────────────────────────────

  it('passes custom timeout to executeCommand', async () => {
    const configWithTimeout: AgentTaskConfig = {
      ...DEFAULT_CONFIG,
      timeoutSeconds: 600,
    };

    await client.executeTask(configWithTimeout);

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'npm test',
      '/home/daytona/workspace',
      expect.any(Object),
      600,
    );
  });
});

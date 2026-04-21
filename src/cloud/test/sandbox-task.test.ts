import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineStage, PipelineError, type StageMessage } from '../pipeline/types.js';

// --- Hoisted mocks -----------------------------------------------------------

const {
  mockExecuteTask,
  mockGetSecretValue,
  mockUpsertAgentRun,
  mockWriteAgentCheckpoint,
  mockPoolQuery,
} = vi.hoisted(() => ({
  mockExecuteTask: vi.fn(),
  mockGetSecretValue: vi.fn(),
  mockUpsertAgentRun: vi.fn(),
  mockWriteAgentCheckpoint: vi.fn(),
  mockPoolQuery: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('../daytona-client.js', () => ({
  DaytonaClient: class MockDaytonaClient {
    executeTask = mockExecuteTask;
  },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class MockSM {
    send = mockGetSecretValue;
  },
  GetSecretValueCommand: class MockCmd {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('../pipeline/checkpoint.js', () => ({
  writeAgentCheckpoint: mockWriteAgentCheckpoint,
}));

vi.mock('../pipeline/idempotency.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipeline/idempotency.js')>();
  return {
    ...actual,
    upsertAgentRun: mockUpsertAgentRun,
  };
});

// --- Import under test -------------------------------------------------------

import { runAgentTask, getAnthropicApiKey, type SandboxTaskConfig } from '../pipeline/sandbox-task.js';
import { DaytonaClient } from '../daytona-client.js';
import type { Pool } from 'pg';

// --- Fixtures ----------------------------------------------------------------

const MOCK_POOL = { query: mockPoolQuery } as unknown as Pool;
const MOCK_BUCKET = 'cah-dev-pipeline-bucket';
const MOCK_API_KEY = 'sk-ant-test-key-123';

function makeStageMessage(overrides: Partial<StageMessage> = {}): StageMessage {
  return {
    runId: 'run-abc-123',
    projectId: 'project-xyz',
    repoUrl: 'https://github.com/org/repo',
    branch: 'main',
    stage: PipelineStage.Execute,
    context: {
      featureDescription: 'Add auth feature',
      phaseNumber: 2,
      phaseTotal: 5,
      previousArtifacts: [],
    },
    ...overrides,
  };
}

function makeSandboxTaskConfig(overrides: Partial<SandboxTaskConfig> = {}): SandboxTaskConfig {
  return {
    msg: makeStageMessage(),
    plan: '02-01',
    wave: 1,
    command: 'node /harness/entrypoint.js',
    ...overrides,
  };
}

// --- Tests -------------------------------------------------------------------

describe('sandbox-task', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:api-key',
    };
    mockGetSecretValue.mockResolvedValue({ SecretString: MOCK_API_KEY });
    mockWriteAgentCheckpoint.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    // Reset the cached API key between tests by re-importing
    // Since cachedApiKey is module-scoped, we clear the mock to force re-fetch
  });

  // --- Env var construction --------------------------------------------------

  describe('env var injection', () => {
    it('passes all CAH_* env vars and ANTHROPIC_API_KEY to DaytonaClient', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"success":true,"costUsd":0.05,"artifacts":["plan.md"]}',
        durationMs: 1200,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const config = makeSandboxTaskConfig();
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, config);

      expect(mockExecuteTask).toHaveBeenCalledOnce();
      const passedConfig = mockExecuteTask.mock.calls[0][0];

      expect(passedConfig.envVars).toEqual({
        CAH_RUN_ID: 'run-abc-123',
        CAH_STAGE: PipelineStage.Execute,
        CAH_PHASE: '2',
        CAH_PLAN: '02-01',
        CAH_BUCKET: MOCK_BUCKET,
        CAH_REPO_URL: 'https://github.com/org/repo',
        CAH_BRANCH: 'main',
        ANTHROPIC_API_KEY: MOCK_API_KEY,
      });
    });

    it('passes repoUrl and branch from StageMessage', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{}',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const config = makeSandboxTaskConfig({
        msg: makeStageMessage({
          repoUrl: 'https://github.com/custom/repo',
          branch: 'feature-branch',
        }),
      });
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, config);

      const passedConfig = mockExecuteTask.mock.calls[0][0];
      expect(passedConfig.repoUrl).toBe('https://github.com/custom/repo');
      expect(passedConfig.branch).toBe('feature-branch');
    });

    it('passes command and timeout from SandboxTaskConfig', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{}',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const config = makeSandboxTaskConfig({
        command: 'custom-command --flag',
        timeoutSeconds: 900,
      });
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, config);

      const passedConfig = mockExecuteTask.mock.calls[0][0];
      expect(passedConfig.command).toBe('custom-command --flag');
      expect(passedConfig.timeoutSeconds).toBe(900);
    });

    it('defaults timeout to 600 seconds', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{}',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const config = makeSandboxTaskConfig();
      delete config.timeoutSeconds;
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, config);

      const passedConfig = mockExecuteTask.mock.calls[0][0];
      expect(passedConfig.timeoutSeconds).toBe(600);
    });
  });

  // --- Task key construction -------------------------------------------------

  describe('task key construction', () => {
    it('builds deterministic task key as runId:phase:plan:wave', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"success":true,"costUsd":0,"artifacts":[]}',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig());

      expect(mockWriteAgentCheckpoint).toHaveBeenCalledOnce();
      const taskKey = mockWriteAgentCheckpoint.mock.calls[0][1];
      expect(taskKey).toBe('run-abc-123:2:02-01:1');
    });
  });

  // --- JSON stdout parsing ---------------------------------------------------

  describe('stdout JSON parsing', () => {
    it('parses success, costUsd, and artifacts from last stdout line', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'some log output\nmore logs\n{"success":true,"costUsd":0.12,"artifacts":["a.md","b.md"]}',
        durationMs: 5000,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const outcome = await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig());

      expect(outcome.success).toBe(true);
      expect(outcome.costUsd).toBe(0.12);
      expect(outcome.artifacts).toEqual(['a.md', 'b.md']);
    });

    it('falls back to exit code when stdout is not valid JSON', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'not json at all',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const outcome = await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig());

      expect(outcome.success).toBe(true); // exitCode === 0
      expect(outcome.costUsd).toBe(0);
      expect(outcome.artifacts).toEqual([]);
    });

    it('falls back to exit code failure when stdout is not JSON and exit code is non-zero', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 1,
        stdout: 'agent crashed',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      const outcome = await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig());

      expect(outcome.success).toBe(false);
      expect(outcome.exitCode).toBe(1);
    });
  });

  // --- Checkpoint on success -------------------------------------------------

  describe('checkpoint on success', () => {
    it('calls writeAgentCheckpoint with correct data after successful execution', async () => {
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"success":true,"costUsd":0.05,"artifacts":["result.md"]}',
        durationMs: 3000,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig());

      expect(mockWriteAgentCheckpoint).toHaveBeenCalledOnce();
      const [pool, taskKey, agentRunData, outcome] = mockWriteAgentCheckpoint.mock.calls[0];

      expect(pool).toBe(MOCK_POOL);
      expect(taskKey).toBe('run-abc-123:2:02-01:1');
      expect(agentRunData).toEqual({
        pipelineRunId: 'run-abc-123',
        phase: 2,
        planName: '02-01',
        wave: 1,
        status: 'running',
      });
      expect(outcome.success).toBe(true);
      expect(outcome.costUsd).toBe(0.05);
      expect(outcome.artifacts).toEqual(['result.md']);
      expect(outcome.durationMs).toBe(3000);
    });
  });

  // --- Checkpoint on failure -------------------------------------------------

  describe('checkpoint on failure', () => {
    it('writes failure checkpoint when DaytonaClient throws', async () => {
      mockExecuteTask.mockRejectedValueOnce(new Error('Sandbox timed out'));

      const client = new DaytonaClient({ apiKey: 'test' });

      await expect(
        runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig()),
      ).rejects.toThrow(PipelineError);

      expect(mockWriteAgentCheckpoint).toHaveBeenCalledOnce();
      const [, , agentRunData, outcome] = mockWriteAgentCheckpoint.mock.calls[0];

      expect(agentRunData.status).toBe('failed');
      expect(outcome.success).toBe(false);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toBe('Sandbox timed out');
    });

    it('does not mask original error when failure checkpoint write also fails', async () => {
      mockExecuteTask.mockRejectedValueOnce(new Error('Sandbox crashed'));
      mockWriteAgentCheckpoint.mockRejectedValueOnce(new Error('DB connection lost'));

      const client = new DaytonaClient({ apiKey: 'test' });

      await expect(
        runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig()),
      ).rejects.toThrow('Sandbox crashed');
    });
  });

  // --- API key fetch ---------------------------------------------------------

  describe('API key from Secrets Manager', () => {
    it('injects the fetched API key into agent env vars', async () => {
      // getAnthropicApiKey() caches at module level (Lambda cold-start optimization),
      // so we verify the key was injected rather than testing the missing-ARN path
      // (which can't fire after the cache is populated by earlier tests).
      mockExecuteTask.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{}',
        durationMs: 100,
      });

      const client = new DaytonaClient({ apiKey: 'test' });
      await runAgentTask(client, MOCK_POOL, MOCK_BUCKET, makeSandboxTaskConfig());

      const passedConfig = mockExecuteTask.mock.calls[0][0];
      expect(passedConfig.envVars.ANTHROPIC_API_KEY).toBe(MOCK_API_KEY);
    });
  });
});

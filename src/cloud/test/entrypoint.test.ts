import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock functions ─────────────────────────────────────────────────

/**
 * vi.hoisted() ensures these declarations run before vi.mock() factories.
 * This avoids "Cannot access before initialization" errors from ESM hoisting.
 */
const {
  mockDownloadPlanningDir,
  mockUploadModifiedFiles,
  mockExecutePlan,
  mockRunPhase,
  mockExecSync,
  mockSpawnSync,
  mockReadFile,
  mockTrack,
  mockFlush,
} = vi.hoisted(() => ({
  mockDownloadPlanningDir: vi.fn(),
  mockUploadModifiedFiles: vi.fn(),
  mockExecutePlan: vi.fn(),
  mockRunPhase: vi.fn(),
  mockExecSync: vi.fn(),
  mockSpawnSync: vi.fn(),
  mockReadFile: vi.fn(),
  mockTrack: vi.fn(),
  mockFlush: vi.fn().mockResolvedValue(undefined),
}));

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../entrypoint/s3-sync.js', () => ({
  downloadPlanningDir: mockDownloadPlanningDir,
  uploadModifiedFiles: mockUploadModifiedFiles,
}));

vi.mock('../entrypoint/sdk-loader.js', () => ({
  loadSdk: () => Promise.resolve({
    GSD: class MockGSD {
      constructor() {
        // no-op
      }
      executePlan = mockExecutePlan;
      runPhase = mockRunPhase;
    },
  }),
}));

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  spawnSync: mockSpawnSync,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('../analytics.js', () => ({
  track: mockTrack,
  flush: mockFlush,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class MockS3Client {
    constructor() {
      // no-op
    }
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Set up required environment variables for test runs. */
function setRequiredEnv(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    CAH_RUN_ID: 'run-123',
    CAH_STAGE: 'execute',
    CAH_PHASE: '02',
    CAH_PLAN: '02-01-PLAN.md',
    CAH_BUCKET: 'cah-dev-pipeline-bucket',
    CAH_REPO_URL: 'https://github.com/org/repo.git',
    CAH_BRANCH: 'main',
  };

  const envVars = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }
}

/** Clear all CAH_* environment variables. */
function clearEnv(): void {
  const keys = [
    'CAH_RUN_ID', 'CAH_STAGE', 'CAH_PHASE', 'CAH_PLAN',
    'CAH_BUCKET', 'CAH_REPO_URL', 'CAH_BRANCH',
    'CAH_FEATURE_BRANCH', 'CAH_WAVE', 'CAH_GITHUB_TOKEN',
    'CAH_PROJECT_ID',
  ];
  for (const key of keys) {
    delete process.env[key];
  }
}

// ─── Import ─────────────────────────────────────────────────────────────────

import { main } from '../entrypoint/agent-entrypoint.js';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('agent-entrypoint', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearEnv();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Set up default mock return values
    mockDownloadPlanningDir.mockResolvedValue(5);
    mockUploadModifiedFiles.mockResolvedValue([
      'runs/run-123/phases/02/SUMMARY.md',
    ]);
    mockExecutePlan.mockResolvedValue({
      success: true,
      totalCostUsd: 1.25,
      durationMs: 30000,
      usage: {
        inputTokens: 15000,
        outputTokens: 3500,
        cacheReadInputTokens: 8000,
        cacheCreationInputTokens: 2000,
      },
    });
    mockRunPhase.mockResolvedValue({
      success: true,
      totalCostUsd: 2.50,
      totalDurationMs: 60000,
    });
    mockExecSync.mockReturnValue('');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockReadFile.mockResolvedValue(Buffer.from('file content'));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    clearEnv();
  });

  // ─── Env validation ─────────────────────────────────────────────────────

  describe('environment variable validation', () => {
    it('throws Error when CAH_RUN_ID is missing', async () => {
      setRequiredEnv();
      delete process.env.CAH_RUN_ID;

      await expect(main()).rejects.toThrow(
        'Required environment variable CAH_RUN_ID is not set',
      );
    });

    it('throws Error when CAH_STAGE is missing', async () => {
      setRequiredEnv();
      delete process.env.CAH_STAGE;

      await expect(main()).rejects.toThrow(
        'Required environment variable CAH_STAGE is not set',
      );
    });

    it('throws Error when CAH_BUCKET is missing', async () => {
      setRequiredEnv();
      delete process.env.CAH_BUCKET;

      await expect(main()).rejects.toThrow(
        'Required environment variable CAH_BUCKET is not set',
      );
    });
  });

  // ─── S3 context download ────────────────────────────────────────────────

  describe('S3 context download', () => {
    it('calls downloadPlanningDir with correct bucket, runId, and workDir', async () => {
      setRequiredEnv();

      await main();

      expect(mockDownloadPlanningDir).toHaveBeenCalledOnce();
      expect(mockDownloadPlanningDir).toHaveBeenCalledWith(
        'cah-dev-pipeline-bucket',
        'run-123',
        expect.any(String), // workDir
        expect.anything(),  // S3Client instance
      );
    });
  });

  // ─── Agent execution ───────────────────────────────────────────────────

  describe('agent execution', () => {
    it('calls GSD.executePlan for execute stage', async () => {
      setRequiredEnv({ CAH_STAGE: 'execute' });

      await main();

      expect(mockExecutePlan).toHaveBeenCalledOnce();
      expect(mockExecutePlan).toHaveBeenCalledWith('02-01-PLAN.md');
    });

    it('calls GSD.runPhase for research stage', async () => {
      setRequiredEnv({ CAH_STAGE: 'research' });

      await main();

      expect(mockRunPhase).toHaveBeenCalledOnce();
      expect(mockRunPhase).toHaveBeenCalledWith('02');
    });

    it('calls GSD.runPhase for plan stage', async () => {
      setRequiredEnv({ CAH_STAGE: 'plan' });

      await main();

      expect(mockRunPhase).toHaveBeenCalledOnce();
      expect(mockRunPhase).toHaveBeenCalledWith('02');
    });

    it('calls GSD.runPhase for verify stage', async () => {
      setRequiredEnv({ CAH_STAGE: 'verify' });

      await main();

      expect(mockRunPhase).toHaveBeenCalledOnce();
      expect(mockRunPhase).toHaveBeenCalledWith('02');
    });

    it('skips agent execution for approve stage (auto-approve per D-10)', async () => {
      setRequiredEnv({ CAH_STAGE: 'approve' });

      await main();

      expect(mockExecutePlan).not.toHaveBeenCalled();
      expect(mockRunPhase).not.toHaveBeenCalled();
    });

    it('skips agent execution for pr stage (Phase 3 stub)', async () => {
      setRequiredEnv({ CAH_STAGE: 'pr' });

      await main();

      expect(mockExecutePlan).not.toHaveBeenCalled();
      expect(mockRunPhase).not.toHaveBeenCalled();
    });

    it('throws Error for unknown stage', async () => {
      setRequiredEnv({ CAH_STAGE: 'invalid' });

      await expect(main()).rejects.toThrow('Unknown stage: invalid');
    });
  });

  // ─── Upload modified files ─────────────────────────────────────────────

  describe('upload modified files', () => {
    it('calls uploadModifiedFiles after agent completes', async () => {
      setRequiredEnv();
      mockExecSync.mockReturnValue(Buffer.from('SUMMARY.md\n'));
      mockReadFile.mockResolvedValue(Buffer.from('# Summary'));

      await main();

      expect(mockUploadModifiedFiles).toHaveBeenCalledOnce();
      expect(mockUploadModifiedFiles).toHaveBeenCalledWith(
        'cah-dev-pipeline-bucket',
        'run-123',
        '02',
        expect.any(Array),
        expect.anything(), // S3Client instance
      );
    });
  });

  // ─── JSON result output ────────────────────────────────────────────────

  describe('JSON result output', () => {
    it('writes JSON result to stdout with success, costUsd, durationMs, artifacts', async () => {
      setRequiredEnv({ CAH_STAGE: 'execute' });
      mockUploadModifiedFiles.mockResolvedValueOnce(['runs/run-123/phases/02/SUMMARY.md']);

      await main();

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output).toHaveProperty('success', true);
      expect(output).toHaveProperty('costUsd');
      expect(output).toHaveProperty('durationMs');
      expect(output).toHaveProperty('artifacts');
      expect(output.artifacts).toEqual(['runs/run-123/phases/02/SUMMARY.md']);
    });
  });

  // ─── Git operations (D-06) ──────────────────────────────────────────────

  describe('git operations', () => {
    it('creates task branch when CAH_FEATURE_BRANCH and CAH_GITHUB_TOKEN are set', async () => {
      setRequiredEnv({
        CAH_STAGE: 'execute',
        CAH_FEATURE_BRANCH: 'cah/run-123/my-feature',
        CAH_GITHUB_TOKEN: 'ghp_test123',
        CAH_WAVE: '2',
      });

      await main();

      // createTaskBranch uses spawnSync for git fetch and git checkout
      const spawnCalls = mockSpawnSync.mock.calls.map(
        (c: [string, string[], ...unknown[]]) => [c[0], c[1]],
      );
      expect(spawnCalls).toContainEqual(
        ['git', ['fetch', 'origin', 'cah/run-123/my-feature']],
      );
      expect(spawnCalls.some(([cmd, args]: [string, string[]]) =>
        cmd === 'git' && args[0] === 'checkout' && args[1] === '-b' && args[2] === 'cah/run-123/02-02-01-PLAN.md-2',
      )).toBe(true);
    });

    it('commits and pushes after successful execution', async () => {
      setRequiredEnv({
        CAH_STAGE: 'execute',
        CAH_FEATURE_BRANCH: 'cah/run-123/my-feature',
        CAH_GITHUB_TOKEN: 'ghp_test123',
      });
      // Return non-empty status so commit happens (git add and git status still use execSync)
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('git status --porcelain')) {
          return 'M src/file.ts';
        }
        return '';
      });

      await main();

      // commitAndPush uses spawnSync for git commit and git push
      const spawnCalls = mockSpawnSync.mock.calls.map(
        (c: [string, string[], ...unknown[]]) => [c[0], c[1]],
      );
      expect(spawnCalls.some(([cmd, args]: [string, string[]]) =>
        cmd === 'git' && args[0] === 'push' && args[1] === 'origin' && args[2] === 'cah/run-123/02-02-01-PLAN.md-1',
      )).toBe(true);
      expect(spawnCalls.some(([cmd, args]: [string, string[]]) =>
        cmd === 'git' && args[0] === 'commit',
      )).toBe(true);
    });

    it('skips git operations when CAH_FEATURE_BRANCH is not set', async () => {
      setRequiredEnv({ CAH_STAGE: 'execute' });
      // No CAH_FEATURE_BRANCH or CAH_GITHUB_TOKEN

      await main();

      // spawnSync should not have been called for git checkout or git push
      const spawnCalls = mockSpawnSync.mock.calls.map(
        (c: [string, string[], ...unknown[]]) => [c[0], c[1]],
      );
      expect(spawnCalls.every(([cmd, args]: [string, string[]]) =>
        !(cmd === 'git' && args[0] === 'checkout'),
      )).toBe(true);
      expect(spawnCalls.every(([cmd, args]: [string, string[]]) =>
        !(cmd === 'git' && args[0] === 'push'),
      )).toBe(true);
    });

    it('skips push when execution fails', async () => {
      setRequiredEnv({
        CAH_STAGE: 'execute',
        CAH_FEATURE_BRANCH: 'cah/run-123/my-feature',
        CAH_GITHUB_TOKEN: 'ghp_test123',
      });
      mockExecutePlan.mockResolvedValueOnce({
        success: false,
        totalCostUsd: 0.50,
        durationMs: 10000,
        usage: {
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 500,
        },
      });

      await main();

      // createTaskBranch uses spawnSync — branch should be created (before execution)
      const spawnCalls = mockSpawnSync.mock.calls.map(
        (c: [string, string[], ...unknown[]]) => [c[0], c[1]],
      );
      expect(spawnCalls.some(([cmd, args]: [string, string[]]) =>
        cmd === 'git' && args[0] === 'checkout' && args[1] === '-b',
      )).toBe(true);
      // But push should NOT happen (execution failed)
      expect(spawnCalls.every(([cmd, args]: [string, string[]]) =>
        !(cmd === 'git' && args[0] === 'push'),
      )).toBe(true);
    });

    it('configures git auth with credential helper and user config', async () => {
      setRequiredEnv({
        CAH_STAGE: 'execute',
        CAH_FEATURE_BRANCH: 'cah/run-123/my-feature',
        CAH_GITHUB_TOKEN: 'ghp_test123',
      });

      await main();

      const calls = mockExecSync.mock.calls.map(
        (c: [string, ...unknown[]]) => c[0],
      );
      expect(calls.some((c: string) =>
        c.includes('git config credential.helper'),
      )).toBe(true);
      expect(calls.some((c: string) =>
        c.includes('git config user.email'),
      )).toBe(true);
      expect(calls.some((c: string) =>
        c.includes('git config user.name'),
      )).toBe(true);
    });
  });

  // ─── PostHog tracking (D-14 / INTG-04) ─────────────────────────────────

  describe('PostHog tracking', () => {
    it('tracks agent_run_completed event with cost data', async () => {
      setRequiredEnv({
        CAH_STAGE: 'execute',
        CAH_PROJECT_ID: 'proj-abc',
      });

      await main();

      expect(mockTrack).toHaveBeenCalledOnce();
      expect(mockTrack).toHaveBeenCalledWith(
        'agent_run_completed',
        expect.objectContaining({
          runId: 'run-123',
          phase: '02',
          plan: '02-01-PLAN.md',
          wave: '1',
          costUsd: 1.25,
          success: true,
          projectId: 'proj-abc',
          inputTokens: 15000,
          outputTokens: 3500,
          cacheReadInputTokens: 8000,
          cacheCreationInputTokens: 2000,
        }),
      );
    });

    it('uses zero-value token usage when result.usage is undefined', async () => {
      setRequiredEnv({ CAH_STAGE: 'execute' });
      mockExecutePlan.mockResolvedValueOnce({
        success: true,
        totalCostUsd: 0.50,
        durationMs: 5000,
      });

      await main();

      expect(mockTrack).toHaveBeenCalledWith(
        'agent_run_completed',
        expect.objectContaining({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
      );
    });

    it('calls flush() before returning', async () => {
      setRequiredEnv({ CAH_STAGE: 'execute' });

      await main();

      expect(mockFlush).toHaveBeenCalledOnce();
    });

    it('tracks agent_run_completed even when git operations are skipped', async () => {
      setRequiredEnv({ CAH_STAGE: 'execute' });
      // No CAH_FEATURE_BRANCH set

      await main();

      expect(mockTrack).toHaveBeenCalledOnce();
      expect(mockTrack).toHaveBeenCalledWith(
        'agent_run_completed',
        expect.objectContaining({
          runId: 'run-123',
          success: true,
        }),
      );
    });
  });
});

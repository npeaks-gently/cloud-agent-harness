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
  mockReadFile,
} = vi.hoisted(() => ({
  mockDownloadPlanningDir: vi.fn(),
  mockUploadModifiedFiles: vi.fn(),
  mockExecutePlan: vi.fn(),
  mockRunPhase: vi.fn(),
  mockExecSync: vi.fn(),
  mockReadFile: vi.fn(),
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
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
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
    });
    mockRunPhase.mockResolvedValue({
      success: true,
      totalCostUsd: 2.50,
      totalDurationMs: 60000,
    });
    mockExecSync.mockReturnValue(Buffer.from(''));
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
});

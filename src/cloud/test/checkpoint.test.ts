import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { PipelineError, PipelineStage } from '../pipeline/types.js';

// --- Mocks -------------------------------------------------------------------

const mockQuery = vi.fn();

const mockPool = { query: mockQuery } as unknown as Pool;

vi.mock('../pipeline/idempotency.js', () => ({
  upsertAgentRun: vi.fn(),
  getCompletedTasks: vi.fn(),
}));

// --- Lazy imports (after mock registration) ----------------------------------

const { upsertAgentRun, getCompletedTasks } = await import('../pipeline/idempotency.js');

const {
  writeAgentCheckpoint,
  updatePipelineStage,
  getPipelineState,
} = await import('../pipeline/checkpoint.js');

// --- Fixtures ----------------------------------------------------------------

const MOCK_AGENT_RUN_DATA = {
  pipelineRunId: 'pipeline-123',
  phase: 2,
  planName: '02-01',
  wave: 1,
  status: 'running' as const,
};

const MOCK_OUTCOME = {
  taskKey: 'pipeline-123:2:02-01:1',
  success: true,
  exitCode: 0,
  durationMs: 5000,
  costUsd: 0.12,
  artifacts: ['summary.md', 'code.ts'],
};

// --- Tests -------------------------------------------------------------------

describe('checkpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
  });

  // --- writeAgentCheckpoint ------------------------------------------------

  describe('writeAgentCheckpoint', () => {
    it('calls upsertAgentRun with completed status on success', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await writeAgentCheckpoint(mockPool, 'task-key-1', MOCK_AGENT_RUN_DATA, MOCK_OUTCOME);

      expect(upsertAgentRun).toHaveBeenCalledOnce();
      const [, , data] = (upsertAgentRun as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(data.status).toBe('completed');
    });

    it('calls upsertAgentRun with failed status on failure', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const failedOutcome = { ...MOCK_OUTCOME, success: false };

      await writeAgentCheckpoint(mockPool, 'task-key-1', MOCK_AGENT_RUN_DATA, failedOutcome);

      const [, , data] = (upsertAgentRun as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(data.status).toBe('failed');
    });

    it('executes UPDATE with cost, duration, artifacts, and error fields', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await writeAgentCheckpoint(mockPool, 'task-key-1', MOCK_AGENT_RUN_DATA, MOCK_OUTCOME);

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE agent_runs SET');
      expect(sql).toContain('cost_usd');
      expect(sql).toContain('duration_ms');
      expect(sql).toContain('artifacts');
      expect(params).toContain(0.12); // costUsd
      expect(params).toContain(5000); // durationMs
      expect(params).toContain('task-key-1'); // taskKey
    });

    it('throws PipelineError when UPDATE query fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));

      await expect(
        writeAgentCheckpoint(mockPool, 'task-key-1', MOCK_AGENT_RUN_DATA, MOCK_OUTCOME),
      ).rejects.toThrow(PipelineError);
    });
  });

  // --- updatePipelineStage -------------------------------------------------

  describe('updatePipelineStage', () => {
    it('updates pipeline_runs with stage and running status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await updatePipelineStage(mockPool, 'run-1', PipelineStage.Research);

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE pipeline_runs');
      expect(sql).toContain('current_stage');
      expect(sql).toContain('running');
      expect(params).toContain('research');
      expect(params).toContain('run-1');
    });

    it('sets status to completed when stage is null (pipeline finished)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await updatePipelineStage(mockPool, 'run-1', null);

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params).toContain('run-1');
    });

    it('throws PipelineError on query failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('deadlock'));

      await expect(
        updatePipelineStage(mockPool, 'run-1', PipelineStage.Execute),
      ).rejects.toThrow(PipelineError);
    });
  });

  // --- getPipelineState ----------------------------------------------------

  describe('getPipelineState', () => {
    it('returns currentStage, status, and completedTasks for a run', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ current_stage: 'research', status: 'running' }],
      });
      vi.mocked(getCompletedTasks).mockResolvedValueOnce(['task-1', 'task-2']);

      const result = await getPipelineState(mockPool, 'run-1');

      expect(result).toEqual({
        currentStage: 'research',
        status: 'running',
        completedTasks: ['task-1', 'task-2'],
      });
    });

    it('returns null when pipeline run does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getPipelineState(mockPool, 'nonexistent');

      expect(result).toBeNull();
    });

    it('throws PipelineError on query failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('timeout'));

      await expect(
        getPipelineState(mockPool, 'run-1'),
      ).rejects.toThrow(PipelineError);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTaskId, upsertAgentRun, getCompletedTasks } from '../pipeline/idempotency.js';
import { PipelineError } from '../pipeline/types.js';

// --- Mocks -------------------------------------------------------------------

const mockQuery = vi.fn();

vi.mock('pg', () => {
  return {
    Pool: class MockPool {
      options: Record<string, unknown>;
      query = mockQuery;

      constructor(config: Record<string, unknown>) {
        this.options = config;
      }
    },
  };
});

// --- Fixtures ----------------------------------------------------------------

const MOCK_AGENT_RUN_DATA = {
  pipelineRunId: 'pipeline-123',
  phase: 2,
  planName: '02-01',
  wave: 1,
  status: 'running' as const,
};

// --- Tests -------------------------------------------------------------------

describe('idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
  });

  // --- buildTaskId -----------------------------------------------------------

  describe('buildTaskId', () => {
    it('returns colon-separated string from runId, phase, plan, wave', () => {
      const result = buildTaskId('run-1', 'research', 'main', 1);
      expect(result).toBe('run-1:research:main:1');
    });

    it('handles execute stage with numbered plan', () => {
      const result = buildTaskId('run-1', 'execute', '02-01', 2);
      expect(result).toBe('run-1:execute:02-01:2');
    });
  });

  // --- upsertAgentRun --------------------------------------------------------

  describe('upsertAgentRun', () => {
    it('calls pool.query with INSERT containing ON CONFLICT (task_key) DO UPDATE', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      await upsertAgentRun(pool, 'run-1:research:main:1', MOCK_AGENT_RUN_DATA);

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (task_key) WHERE task_key IS NOT NULL DO UPDATE');
    });

    it('passes 6 parameters in correct order', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      await upsertAgentRun(pool, 'run-1:research:main:1', MOCK_AGENT_RUN_DATA);

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual([
        'pipeline-123',  // pipelineRunId
        2,               // phase
        '02-01',         // planName
        1,               // wave
        'running',       // status
        'run-1:research:main:1', // taskKey
      ]);
    });

    it('throws PipelineError on query failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      await expect(
        upsertAgentRun(pool, 'run-1:research:main:1', MOCK_AGENT_RUN_DATA),
      ).rejects.toThrow(PipelineError);
    });
  });

  // --- getCompletedTasks -----------------------------------------------------

  describe('getCompletedTasks', () => {
    it('returns array of task_key strings where status is completed', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { task_key: 'run-1:research:main:1' },
          { task_key: 'run-1:plan:main:1' },
        ],
      });
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      const result = await getCompletedTasks(pool, 'pipeline-123');

      expect(result).toEqual(['run-1:research:main:1', 'run-1:plan:main:1']);
    });

    it('filters by stage using plan_name LIKE when stage is provided', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ task_key: 'run-1:research:main:1' }],
      });
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      await getCompletedTasks(pool, 'pipeline-123', 'research');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('LIKE');
      expect(params).toContain('research%');
    });

    it('returns all completed tasks when no stage filter provided', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      await getCompletedTasks(pool, 'pipeline-123');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).not.toContain('LIKE');
      expect(params).toEqual(['pipeline-123']);
    });

    it('throws PipelineError on query failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('timeout'));
      const pool = { query: mockQuery } as unknown as import('pg').Pool;

      await expect(
        getCompletedTasks(pool, 'pipeline-123'),
      ).rejects.toThrow(PipelineError);
    });
  });
});

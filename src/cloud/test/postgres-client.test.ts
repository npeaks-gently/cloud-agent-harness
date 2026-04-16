import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDbPool,
  insertPipelineRun,
  getPipelineRun,
  insertAgentRun,
  updateAgentRun,
  mapRowToPipelineRun,
  mapRowToAgentRun,
} from '../postgres-client.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('postgres-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
  });

  // ─── createDbPool ─────────────────────────────────────────────────────

  describe('createDbPool', () => {
    it('creates Pool with ssl configuration', () => {
      const pool = createDbPool('postgresql://localhost/test');
      // Access the options stored by the mock constructor
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      const ssl = opts.ssl as Record<string, unknown>;
      // When RDS CA bundle is present: rejectUnauthorized true + ca buffer
      // When missing (e.g., tests): rejectUnauthorized false (still encrypted)
      expect(typeof ssl.rejectUnauthorized).toBe('boolean');
    });

    it('creates Pool with connectionTimeoutMillis 10000', () => {
      const pool = createDbPool('postgresql://localhost/test');
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts.connectionTimeoutMillis).toBe(10000);
    });

    it('creates Pool with max 5 connections', () => {
      const pool = createDbPool('postgresql://localhost/test');
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts.max).toBe(5);
    });

    it('creates Pool with idleTimeoutMillis 30000', () => {
      const pool = createDbPool('postgresql://localhost/test');
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts.idleTimeoutMillis).toBe(30000);
    });

    it('passes connection string to Pool', () => {
      const pool = createDbPool('postgresql://user:pass@host/db');
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts.connectionString).toBe('postgresql://user:pass@host/db');
    });
  });

  // ─── insertPipelineRun ────────────────────────────────────────────────

  describe('insertPipelineRun', () => {
    it('calls pool.query with correct INSERT SQL and $1/$2/$3 params', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-123' }] });
      const pool = createDbPool('postgresql://localhost/test');
      const config = { model: 'claude-opus-4-6' };

      await insertPipelineRun(pool, 'project-abc', 3, config);

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO pipeline_runs');
      expect(sql).toContain('$1');
      expect(sql).toContain('$2');
      expect(sql).toContain('$3');
      expect(params).toEqual(['project-abc', 3, JSON.stringify(config)]);
    });

    it('returns the id from result.rows[0].id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-456' }] });
      const pool = createDbPool('postgresql://localhost/test');

      const id = await insertPipelineRun(pool, 'proj', 1, {});

      expect(id).toBe('uuid-456');
    });
  });

  // ─── getPipelineRun ───────────────────────────────────────────────────

  describe('getPipelineRun', () => {
    it('returns null when no rows returned', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = createDbPool('postgresql://localhost/test');

      const result = await getPipelineRun(pool, 'nonexistent');

      expect(result).toBeNull();
    });

    it('maps snake_case columns to camelCase PipelineRun', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'uuid-789',
          project_id: 'proj-1',
          status: 'running',
          phase_current: 2,
          phase_total: 5,
          config: '{"key":"value"}',
          created_at: '2026-04-15T00:00:00Z',
          updated_at: '2026-04-15T01:00:00Z',
        }],
      });
      const pool = createDbPool('postgresql://localhost/test');

      const result = await getPipelineRun(pool, 'uuid-789');

      expect(result).not.toBeNull();
      expect(result!.projectId).toBe('proj-1');
      expect(result!.phaseCurrent).toBe(2);
      expect(result!.phaseTotal).toBe(5);
      expect(result!.config).toEqual({ key: 'value' });
      expect(result!.createdAt).toBeInstanceOf(Date);
      expect(result!.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── insertAgentRun ───────────────────────────────────────────────────

  describe('insertAgentRun', () => {
    it('sets status to running and started_at', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid-1' }] });
      const pool = createDbPool('postgresql://localhost/test');

      await insertAgentRun(pool, 'pipeline-1', 1, '01-02', 1);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('started_at');
      expect(sql).toContain('NOW()');
      expect(params).toContain('running');
    });

    it('returns the generated id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid-2' }] });
      const pool = createDbPool('postgresql://localhost/test');

      const id = await insertAgentRun(pool, 'pipeline-1', 1, '01-02', 1);

      expect(id).toBe('agent-uuid-2');
    });
  });

  // ─── updateAgentRun ───────────────────────────────────────────────────

  describe('updateAgentRun', () => {
    it('builds dynamic SET clause from provided fields', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = createDbPool('postgresql://localhost/test');

      await updateAgentRun(pool, 'agent-1', {
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.05,
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('input_tokens = $1');
      expect(sql).toContain('output_tokens = $2');
      expect(sql).toContain('cost_usd = $3');
      expect(params).toEqual([1000, 500, 0.05, 'agent-1']);
    });

    it('sets completed_at when status is completed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = createDbPool('postgresql://localhost/test');

      await updateAgentRun(pool, 'agent-1', { status: 'completed' });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('completed_at = NOW()');
    });

    it('sets completed_at when status is failed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = createDbPool('postgresql://localhost/test');

      await updateAgentRun(pool, 'agent-1', {
        status: 'failed',
        errorMessage: 'timeout',
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('completed_at = NOW()');
    });

    it('does not call query when no fields provided', async () => {
      const pool = createDbPool('postgresql://localhost/test');

      await updateAgentRun(pool, 'agent-1', {});

      // mockQuery is called by createDbPool, but not by updateAgentRun
      // since createDbPool doesn't call query, mockQuery should not be called
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // ─── Row mappers ──────────────────────────────────────────────────────

  describe('mapRowToPipelineRun', () => {
    it('converts snake_case to camelCase correctly', () => {
      const row = {
        id: 'test-id',
        project_id: 'proj-1',
        status: 'pending',
        phase_current: 0,
        phase_total: 3,
        config: { foo: 'bar' },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T12:00:00Z',
      };

      const result = mapRowToPipelineRun(row);

      expect(result.projectId).toBe('proj-1');
      expect(result.phaseCurrent).toBe(0);
      expect(result.phaseTotal).toBe(3);
    });
  });

  describe('mapRowToAgentRun', () => {
    it('converts snake_case to camelCase correctly', () => {
      const row = {
        id: 'agent-1',
        pipeline_run_id: 'pipe-1',
        phase: 1,
        plan_name: '01-01',
        wave: 1,
        status: 'running',
        session_id: 'sess-1',
        model: 'claude-opus-4-6',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.01,
        duration_ms: 5000,
        error_message: undefined,
        artifacts: ['a.md', 'b.md'],
        started_at: '2026-01-01T00:00:00Z',
        completed_at: null,
        created_at: '2026-01-01T00:00:00Z',
      };

      const result = mapRowToAgentRun(row);

      expect(result.pipelineRunId).toBe('pipe-1');
      expect(result.planName).toBe('01-01');
      expect(result.sessionId).toBe('sess-1');
      expect(result.inputTokens).toBe(100);
      expect(result.costUsd).toBe(0.01);
      expect(result.artifacts).toEqual(['a.md', 'b.md']);
    });
  });
});

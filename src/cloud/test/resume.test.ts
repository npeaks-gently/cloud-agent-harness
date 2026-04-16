import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { PipelineError, PipelineStage } from '../pipeline/types.js';

// --- Mocks -------------------------------------------------------------------

const mockGetPipelineState = vi.fn();

vi.mock('../pipeline/checkpoint.js', () => ({
  getPipelineState: (...args: unknown[]) => mockGetPipelineState(...args),
}));

const { resumePipeline } = await import('../pipeline/resume.js');

// --- Fixtures ----------------------------------------------------------------

const mockPool = { query: vi.fn() } as unknown as Pool;

// --- Tests -------------------------------------------------------------------

describe('resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- resumePipeline -------------------------------------------------------

  describe('resumePipeline', () => {
    it('returns stage and completed tasks for a partially completed pipeline', async () => {
      mockGetPipelineState.mockResolvedValueOnce({
        currentStage: 'execute',
        status: 'running',
        completedTasks: ['task-1', 'task-2', 'task-3'],
      });

      const result = await resumePipeline(mockPool, 'run-1');

      expect(result.stage).toBe(PipelineStage.Execute);
      expect(result.completedTasks).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('returns Intake stage for a brand new run (pending status)', async () => {
      mockGetPipelineState.mockResolvedValueOnce({
        currentStage: 'intake',
        status: 'pending',
        completedTasks: [],
      });

      const result = await resumePipeline(mockPool, 'run-new');

      expect(result.stage).toBe(PipelineStage.Intake);
      expect(result.completedTasks).toEqual([]);
    });

    it('throws PipelineError when pipeline run is not found', async () => {
      mockGetPipelineState.mockResolvedValueOnce(null);

      await expect(
        resumePipeline(mockPool, 'nonexistent'),
      ).rejects.toThrow(PipelineError);

      await expect(
        resumePipeline(mockPool, 'nonexistent'),
      ).rejects.toThrow(/not found/);
    });
  });
});

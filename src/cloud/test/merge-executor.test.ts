import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

// --- Import under test (after mocks) ----------------------------------------

import { mergeTaskBranches, MergeError } from '../pipeline/merge-executor.js';

// --- Tests -------------------------------------------------------------------

describe('mergeTaskBranches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('');
  });

  it('checks out feature branch then merges each task branch', async () => {
    const merged = await mergeTaskBranches('/repo', 'feature-branch', ['task-1', 'task-2']);

    // First call: checkout
    expect(mockExecSync).toHaveBeenCalledWith(
      'git checkout feature-branch',
      { cwd: '/repo', encoding: 'utf-8' },
    );

    // Second call: merge task-1
    expect(mockExecSync).toHaveBeenCalledWith(
      'git merge task-1 --no-ff -m "Merge task-1 into feature-branch"',
      { cwd: '/repo', encoding: 'utf-8' },
    );

    // Third call: merge task-2
    expect(mockExecSync).toHaveBeenCalledWith(
      'git merge task-2 --no-ff -m "Merge task-2 into feature-branch"',
      { cwd: '/repo', encoding: 'utf-8' },
    );

    expect(merged).toEqual(['task-1', 'task-2']);
  });

  it('returns list of merged branches', async () => {
    const merged = await mergeTaskBranches('/repo', 'feature', ['a', 'b', 'c']);

    expect(merged).toEqual(['a', 'b', 'c']);
    expect(merged).toHaveLength(3);
  });

  it('throws MergeError on conflict and aborts merge', async () => {
    // Checkout succeeds, first merge succeeds, second merge fails
    mockExecSync
      .mockReturnValueOnce('') // checkout
      .mockReturnValueOnce('') // merge task-1
      .mockImplementationOnce(() => { throw new Error('Merge conflict'); }) // merge task-2
      .mockReturnValueOnce(''); // merge --abort

    try {
      await mergeTaskBranches('/repo', 'feature', ['task-1', 'task-2']);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeError);
      const mergeErr = err as MergeError;
      expect(mergeErr.message).toContain('Merge conflict on branch task-2');
      expect(mergeErr.operation).toBe('mergeTaskBranches');
      expect(mergeErr.branch).toBe('task-2');
    }

    // Verify merge --abort was called
    expect(mockExecSync).toHaveBeenCalledWith(
      'git merge --abort',
      { cwd: '/repo' },
    );
  });

  it('with empty taskBranches just checks out feature branch', async () => {
    const merged = await mergeTaskBranches('/repo', 'feature', []);

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      'git checkout feature',
      { cwd: '/repo', encoding: 'utf-8' },
    );
    expect(merged).toEqual([]);
  });

  it('handles merge abort failure gracefully', async () => {
    // Checkout succeeds, merge fails, abort also fails
    mockExecSync
      .mockReturnValueOnce('') // checkout
      .mockImplementationOnce(() => { throw new Error('Merge conflict'); }) // merge
      .mockImplementationOnce(() => { throw new Error('abort failed'); }); // merge --abort fails

    try {
      await mergeTaskBranches('/repo', 'feature', ['task-1']);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeError);
      expect((err as MergeError).branch).toBe('task-1');
    }
  });
});

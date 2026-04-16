import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineStage, PipelineError, type StageMessage } from '../pipeline/types.js';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockCreatePullRequest,
  mockAttachPrUrl,
  mockUpdateTicketStatus,
  mockTrack,
} = vi.hoisted(() => ({
  mockCreatePullRequest: vi.fn(),
  mockAttachPrUrl: vi.fn(),
  mockUpdateTicketStatus: vi.fn(),
  mockTrack: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('../integrations/github.js', () => ({
  createPullRequest: mockCreatePullRequest,
}));

vi.mock('../integrations/linear.js', () => ({
  attachPrUrl: mockAttachPrUrl,
  updateTicketStatus: mockUpdateTicketStatus,
}));

vi.mock('../analytics.js', () => ({
  track: mockTrack,
}));

// --- Import under test (after mocks) ----------------------------------------

import { handlePrStage } from '../pipeline/stages/pr.js';
import type { Pool } from 'pg';

// --- Fixtures ----------------------------------------------------------------

const mockPoolQuery = vi.fn();
const MOCK_POOL = { query: mockPoolQuery } as unknown as Pool;

function makeStageMessage(overrides: Partial<StageMessage> = {}): StageMessage {
  return {
    runId: 'run-abc-123',
    projectId: 'project-abc',
    repoUrl: 'https://github.com/org/repo',
    branch: 'main',
    stage: PipelineStage.PR,
    context: {
      featureDescription: 'Add user authentication',
      phaseNumber: 2,
      phaseTotal: 5,
      previousArtifacts: [],
      featureBranch: 'cah/abcdef12/add-user-auth',
      linearParentTicketId: 'linear-parent-123',
    },
    ...overrides,
  };
}

// --- Tests -------------------------------------------------------------------

describe('handlePrStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePullRequest.mockResolvedValue({
      url: 'https://github.com/org/repo/pull/42',
      number: 42,
    });
    mockAttachPrUrl.mockResolvedValue(undefined);
    mockUpdateTicketStatus.mockResolvedValue(undefined);
  });

  it('creates PR from feature branch to base', async () => {
    const msg = makeStageMessage();
    await handlePrStage(msg, MOCK_POOL);

    expect(mockCreatePullRequest).toHaveBeenCalledOnce();
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      'org',
      'repo',
      'cah/abcdef12/add-user-auth',
      'main',
      '[CAH] Add user authentication',
      expect.stringContaining('## Pipeline Run'),
    );
  });

  it('attaches PR URL to Linear ticket when linearParentTicketId in context', async () => {
    const msg = makeStageMessage();
    await handlePrStage(msg, MOCK_POOL);

    expect(mockAttachPrUrl).toHaveBeenCalledOnce();
    expect(mockAttachPrUrl).toHaveBeenCalledWith(
      'linear-parent-123',
      'https://github.com/org/repo/pull/42',
    );
  });

  it('marks Linear parent ticket as done', async () => {
    const msg = makeStageMessage();
    await handlePrStage(msg, MOCK_POOL);

    expect(mockUpdateTicketStatus).toHaveBeenCalledOnce();
    expect(mockUpdateTicketStatus).toHaveBeenCalledWith(
      'linear-parent-123',
      'done',
    );
  });

  it('skips Linear operations when no linearParentTicketId', async () => {
    const msg = makeStageMessage({
      context: {
        featureDescription: 'Add user authentication',
        phaseNumber: 2,
        phaseTotal: 5,
        previousArtifacts: [],
        featureBranch: 'cah/abcdef12/add-user-auth',
        // No linearParentTicketId
      },
    });
    await handlePrStage(msg, MOCK_POOL);

    expect(mockAttachPrUrl).not.toHaveBeenCalled();
    expect(mockUpdateTicketStatus).not.toHaveBeenCalled();
  });

  it('tracks pr_created event', async () => {
    const msg = makeStageMessage();
    await handlePrStage(msg, MOCK_POOL);

    expect(mockTrack).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledWith('pr_created', {
      runId: 'run-abc-123',
      projectId: 'project-abc',
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
    });
  });

  it('throws PipelineError when featureBranch is missing from context', async () => {
    const msg = makeStageMessage({
      context: {
        featureDescription: 'Add user authentication',
        phaseNumber: 2,
        phaseTotal: 5,
        previousArtifacts: [],
        // No featureBranch
      },
    });

    try {
      await handlePrStage(msg, MOCK_POOL);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as Error).message).toMatch(/Feature branch is required/);
    }
  });

  it('throws PipelineError when GitHub PR creation fails', async () => {
    mockCreatePullRequest.mockRejectedValue(new Error('GitHub API rate limited'));
    const msg = makeStageMessage();

    try {
      await handlePrStage(msg, MOCK_POOL);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as Error).message).toMatch(/Failed to create pull request/);
    }
  });

  it('returns status completed on success', async () => {
    const msg = makeStageMessage();
    const result = await handlePrStage(msg, MOCK_POOL);

    expect(result.status).toBe('completed');
    expect(result.stage).toBe(PipelineStage.PR);
    expect(result.tasks).toEqual([]);
  });

  it('continues even if Linear attachPrUrl fails (non-critical)', async () => {
    mockAttachPrUrl.mockRejectedValue(new Error('Linear down'));
    const msg = makeStageMessage();

    const result = await handlePrStage(msg, MOCK_POOL);

    expect(result.status).toBe('completed');
    // updateTicketStatus should still be called even if attachPrUrl failed
    expect(mockUpdateTicketStatus).toHaveBeenCalledOnce();
  });

  it('PR body contains run metadata', async () => {
    const msg = makeStageMessage();
    await handlePrStage(msg, MOCK_POOL);

    const body = mockCreatePullRequest.mock.calls[0][5] as string;
    expect(body).toContain('run-abc-123');
    expect(body).toContain('project-abc');
    expect(body).toContain('2/5');
    expect(body).toContain('Automated by Cloud Agent Harness');
  });
});

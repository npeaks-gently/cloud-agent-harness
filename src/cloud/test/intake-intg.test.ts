import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineStage, type StageMessage } from '../pipeline/types.js';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockCreateFeatureBranch,
  mockCreateParentTicket,
  mockUpdatePipelineRunBranch,
  mockUpdatePipelineRunLinearTicket,
  mockTrack,
  mockPoolQuery,
} = vi.hoisted(() => ({
  mockCreateFeatureBranch: vi.fn(),
  mockCreateParentTicket: vi.fn(),
  mockUpdatePipelineRunBranch: vi.fn(),
  mockUpdatePipelineRunLinearTicket: vi.fn(),
  mockTrack: vi.fn(),
  mockPoolQuery: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('../integrations/github.js', () => ({
  createFeatureBranch: mockCreateFeatureBranch,
}));

vi.mock('../integrations/linear.js', () => ({
  createParentTicket: mockCreateParentTicket,
}));

vi.mock('../postgres-client.js', () => ({
  updatePipelineRunBranch: mockUpdatePipelineRunBranch,
  updatePipelineRunLinearTicket: mockUpdatePipelineRunLinearTicket,
}));

vi.mock('../analytics.js', () => ({
  track: mockTrack,
}));

// --- Import under test (after mocks) ----------------------------------------

import { handleIntakeStage, parseRepoUrl } from '../pipeline/stages/intake.js';
import type { Pool } from 'pg';

// --- Fixtures ----------------------------------------------------------------

function makeStageMessage(overrides: Partial<StageMessage> = {}): StageMessage {
  return {
    runId: 'abcdef12-3456-7890-abcd-ef1234567890',
    projectId: 'project-abc',
    repoUrl: 'https://github.com/org/repo',
    branch: 'main',
    stage: PipelineStage.Intake,
    context: {
      featureDescription: 'Add user authentication',
      phaseNumber: 1,
      phaseTotal: 3,
      previousArtifacts: [],
    },
    ...overrides,
  };
}

const MOCK_POOL = { query: mockPoolQuery } as unknown as Pool;

// --- Tests -------------------------------------------------------------------

describe('handleIntakeStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mockCreateFeatureBranch.mockResolvedValue(undefined);
    mockCreateParentTicket.mockResolvedValue({
      ticketId: 'linear-ticket-123',
      identifier: 'CAH-1',
    });
    mockUpdatePipelineRunBranch.mockResolvedValue(undefined);
    mockUpdatePipelineRunLinearTicket.mockResolvedValue(undefined);
  });

  it('creates feature branch with correct name format', async () => {
    const msg = makeStageMessage();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockCreateFeatureBranch).toHaveBeenCalledOnce();
    const [owner, repo, branchName, baseBranch] = mockCreateFeatureBranch.mock.calls[0];
    expect(owner).toBe('org');
    expect(repo).toBe('repo');
    // Branch format: cah/{8-char runId prefix}/{slug}
    expect(branchName).toMatch(/^cah\/abcdef12\/add-user-authentication$/);
    expect(baseBranch).toBe('main');
  });

  it('creates parent Linear ticket', async () => {
    const msg = makeStageMessage();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockCreateParentTicket).toHaveBeenCalledOnce();
    expect(mockCreateParentTicket).toHaveBeenCalledWith(
      'abcdef12-3456-7890-abcd-ef1234567890',
      'Add user authentication',
    );
  });

  it('updates pipeline_runs with branch and ticket ID', async () => {
    const msg = makeStageMessage();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockUpdatePipelineRunBranch).toHaveBeenCalledOnce();
    expect(mockUpdatePipelineRunBranch).toHaveBeenCalledWith(
      MOCK_POOL,
      'abcdef12-3456-7890-abcd-ef1234567890',
      expect.stringMatching(/^cah\/abcdef12\//),
    );

    expect(mockUpdatePipelineRunLinearTicket).toHaveBeenCalledOnce();
    expect(mockUpdatePipelineRunLinearTicket).toHaveBeenCalledWith(
      MOCK_POOL,
      'abcdef12-3456-7890-abcd-ef1234567890',
      'linear-ticket-123',
    );
  });

  it('enriches msg.context with featureBranch and linearParentTicketId', async () => {
    const msg = makeStageMessage();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(msg.context.featureBranch).toMatch(/^cah\/abcdef12\//);
    expect(msg.context.linearParentTicketId).toBe('linear-ticket-123');
  });

  it('tracks pipeline_started event', async () => {
    const msg = makeStageMessage();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockTrack).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledWith('pipeline_started', {
      runId: 'abcdef12-3456-7890-abcd-ef1234567890',
      projectId: 'project-abc',
      stage: PipelineStage.Intake,
      featureBranch: expect.stringMatching(/^cah\/abcdef12\//),
      linearParentTicketId: 'linear-ticket-123',
      hasPlanningContext: false,
    });
  });

  it('still inserts pipeline_run row', async () => {
    const msg = makeStageMessage();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO pipeline_runs');
    expect(params[0]).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(params[1]).toBe('project-abc');
  });

  it('returns status completed', async () => {
    const msg = makeStageMessage();
    const result = await handleIntakeStage(msg, MOCK_POOL);

    expect(result.status).toBe('completed');
    expect(result.stage).toBe(PipelineStage.Intake);
    expect(result.tasks).toEqual([]);
  });
});

describe('parseRepoUrl', () => {
  it('parses full GitHub URL', () => {
    const result = parseRepoUrl('https://github.com/org/repo');
    expect(result).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('parses full GitHub URL with .git suffix', () => {
    const result = parseRepoUrl('https://github.com/org/repo.git');
    expect(result).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('parses shorthand owner/repo format', () => {
    const result = parseRepoUrl('org/repo');
    expect(result).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('throws PipelineError for invalid URL', () => {
    expect(() => parseRepoUrl('invalid-url')).toThrow(/Cannot parse repository URL/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineStage, PipelineError, type StageMessage } from '../pipeline/types.js';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockSendApprovalMessage,
  mockInsertApproval,
  mockTrack,
  mockRandomUUID,
} = vi.hoisted(() => ({
  mockSendApprovalMessage: vi.fn(),
  mockInsertApproval: vi.fn(),
  mockTrack: vi.fn(),
  mockRandomUUID: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('node:crypto', () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock('../integrations/slack.js', () => ({
  sendApprovalMessage: mockSendApprovalMessage,
}));

vi.mock('../postgres-client.js', () => ({
  insertApproval: mockInsertApproval,
}));

vi.mock('../analytics.js', () => ({
  track: mockTrack,
}));

// --- Import under test (after mocks) ----------------------------------------

import { handleApproveStage } from '../pipeline/stages/approve.js';
import type { Pool } from 'pg';

// --- Fixtures ----------------------------------------------------------------

const FIXED_TOKEN = 'test-token-uuid';

function makeStageMessage(overrides: Partial<StageMessage> = {}): StageMessage {
  return {
    runId: 'run-abc-123',
    projectId: 'project-abc',
    repoUrl: 'https://github.com/org/repo',
    branch: 'main',
    stage: PipelineStage.Approve,
    context: {
      featureDescription: 'Add user authentication',
      phaseNumber: 2,
      phaseTotal: 5,
      previousArtifacts: [],
    },
    ...overrides,
  };
}

const mockPoolQuery = vi.fn();
const MOCK_POOL = { query: mockPoolQuery } as unknown as Pool;

// --- Tests -------------------------------------------------------------------

describe('handleApproveStage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRandomUUID.mockReturnValue(FIXED_TOKEN);
    mockSendApprovalMessage.mockResolvedValue('1234567890.123456');
    mockInsertApproval.mockResolvedValue('approval-id-1');
    process.env = { ...originalEnv, SLACK_APPROVAL_CHANNEL: 'C12345' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('sends Slack message with Block Kit content', async () => {
    const msg = makeStageMessage();
    await handleApproveStage(msg, MOCK_POOL);

    expect(mockSendApprovalMessage).toHaveBeenCalledOnce();
    expect(mockSendApprovalMessage).toHaveBeenCalledWith(
      'C12345',
      'run-abc-123',
      'project-abc',
      FIXED_TOKEN,
      expect.stringContaining('Add user authentication'),
    );
  });

  it('writes approval token to Postgres', async () => {
    const msg = makeStageMessage();
    await handleApproveStage(msg, MOCK_POOL);

    expect(mockInsertApproval).toHaveBeenCalledOnce();
    expect(mockInsertApproval).toHaveBeenCalledWith(
      MOCK_POOL,
      'run-abc-123',
      FIXED_TOKEN,
      'C12345',
      '1234567890.123456',
    );
  });

  it('returns status paused', async () => {
    const msg = makeStageMessage();
    const result = await handleApproveStage(msg, MOCK_POOL);

    expect(result.status).toBe('paused');
    expect(result.stage).toBe(PipelineStage.Approve);
    expect(result.tasks).toEqual([]);
  });

  it('tracks approval_requested event', async () => {
    const msg = makeStageMessage();
    await handleApproveStage(msg, MOCK_POOL);

    expect(mockTrack).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledWith('approval_requested', {
      runId: 'run-abc-123',
      projectId: 'project-abc',
      stage: PipelineStage.Approve,
    });
  });

  it('throws PipelineError when Slack send fails', async () => {
    mockSendApprovalMessage.mockRejectedValue(new Error('Slack API down'));
    const msg = makeStageMessage();

    try {
      await handleApproveStage(msg, MOCK_POOL);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as Error).message).toMatch(/Failed to send Slack approval message/);
    }
  });

  it('reads SLACK_APPROVAL_CHANNEL from env', async () => {
    process.env.SLACK_APPROVAL_CHANNEL = 'C99999';
    const msg = makeStageMessage();
    await handleApproveStage(msg, MOCK_POOL);

    expect(mockSendApprovalMessage).toHaveBeenCalledWith(
      'C99999',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('uses empty string for channel when SLACK_APPROVAL_CHANNEL is not set', async () => {
    delete process.env.SLACK_APPROVAL_CHANNEL;
    const msg = makeStageMessage();
    await handleApproveStage(msg, MOCK_POOL);

    expect(mockSendApprovalMessage).toHaveBeenCalledWith(
      '',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('throws PipelineError when Postgres insert fails', async () => {
    mockInsertApproval.mockRejectedValue(new Error('DB connection lost'));
    const msg = makeStageMessage();

    try {
      await handleApproveStage(msg, MOCK_POOL);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as Error).message).toMatch(/Failed to persist approval token/);
    }
  });
});

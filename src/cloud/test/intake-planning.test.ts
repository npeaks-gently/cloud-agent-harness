import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineStage, PipelineError, type StageMessage } from '../pipeline/types.js';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockCreateFeatureBranch,
  mockCreateParentTicket,
  mockUpdatePipelineRunBranch,
  mockUpdatePipelineRunLinearTicket,
  mockTrack,
  mockPoolQuery,
  mockS3Send,
} = vi.hoisted(() => ({
  mockCreateFeatureBranch: vi.fn(),
  mockCreateParentTicket: vi.fn(),
  mockUpdatePipelineRunBranch: vi.fn(),
  mockUpdatePipelineRunLinearTicket: vi.fn(),
  mockTrack: vi.fn(),
  mockPoolQuery: vi.fn(),
  mockS3Send: vi.fn(),
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

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class MockS3Client {
      constructor() {
        // no-op
      }
      send = mockS3Send;
    },
    ListObjectsV2Command: class MockListObjectsV2Command {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    GetObjectCommand: class MockGetObjectCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    PutObjectCommand: class MockPutObjectCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

// --- Import under test (after mocks) ----------------------------------------

import { handleIntakeStage } from '../pipeline/stages/intake.js';
import type { Pool } from 'pg';

// --- Fixtures ----------------------------------------------------------------

const MOCK_POOL = { query: mockPoolQuery } as unknown as Pool;
const TRIGGER_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const RUN_ID = 'run12345-6789-abcd-ef01-234567890abc';

function makeStageMessage(overrides: Partial<StageMessage> = {}): StageMessage {
  return {
    runId: RUN_ID,
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

function makeStageMessageWithPlanning(planningPrefix?: string): StageMessage {
  return makeStageMessage({
    context: {
      featureDescription: 'Add user authentication',
      phaseNumber: 1,
      phaseTotal: 3,
      previousArtifacts: [],
      planningPrefix: planningPrefix ?? `triggers/${TRIGGER_UUID}/planning/`,
    },
  });
}

// --- Tests -------------------------------------------------------------------

describe('handleIntakeStage - planning download', () => {
  const originalEnv = process.env;

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
    process.env = { ...originalEnv, CAH_ARTIFACT_BUCKET: 'cah-dev-pipeline-bucket' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('downloads planning artifacts when planningPrefix is present', async () => {
    const bodyContent = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const prefix = `triggers/${TRIGGER_UUID}/planning/`;

    mockS3Send
      // ListObjectsV2Command
      .mockResolvedValueOnce({
        Contents: [
          { Key: `${prefix}STATE.md` },
          { Key: `${prefix}config.json` },
          { Key: `${prefix}phases/01/01-01-PLAN.md` },
        ],
        IsTruncated: false,
      })
      // GetObjectCommand for STATE.md
      .mockResolvedValueOnce({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
      })
      // PutObjectCommand for STATE.md
      .mockResolvedValueOnce({})
      // GetObjectCommand for config.json
      .mockResolvedValueOnce({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
      })
      // PutObjectCommand for config.json
      .mockResolvedValueOnce({})
      // GetObjectCommand for 01-01-PLAN.md
      .mockResolvedValueOnce({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
      })
      // PutObjectCommand for 01-01-PLAN.md
      .mockResolvedValueOnce({});

    const msg = makeStageMessageWithPlanning();
    await handleIntakeStage(msg, MOCK_POOL);

    // Verify ListObjectsV2 was called
    expect(mockS3Send).toHaveBeenCalled();
    const listCall = mockS3Send.mock.calls[0][0];
    expect(listCall.input.Prefix).toBe(prefix);
    expect(listCall.input.Bucket).toBe('cah-dev-pipeline-bucket');

    // Verify GetObjectCommand called 3 times (calls 1, 3, 5)
    const getCalls = mockS3Send.mock.calls.filter(
      (c: [{ input: Record<string, unknown> }]) => c[0].input.Key !== undefined && !c[0].input.Body && !c[0].input.Prefix,
    );
    expect(getCalls).toHaveLength(3);

    // Verify PutObjectCommand called 3 times with correct dest keys (calls 2, 4, 6)
    const putCalls = mockS3Send.mock.calls.filter(
      (c: [{ input: Record<string, unknown> }]) => c[0].input.Body !== undefined,
    );
    expect(putCalls).toHaveLength(3);

    const putKeys = putCalls.map((c: [{ input: Record<string, unknown> }]) => c[0].input.Key);
    expect(putKeys).toContain(`runs/${RUN_ID}/planning/STATE.md`);
    expect(putKeys).toContain(`runs/${RUN_ID}/planning/config.json`);
    expect(putKeys).toContain(`runs/${RUN_ID}/planning/phases/01/01-01-PLAN.md`);

    // Verify SHA256 checksum on PutObjectCommands
    for (const call of putCalls) {
      expect((call as [{ input: Record<string, unknown> }])[0].input.ChecksumAlgorithm).toBe('SHA256');
    }
  });

  it('skips planning download when planningPrefix is absent', async () => {
    const msg = makeStageMessage(); // no planningPrefix
    await handleIntakeStage(msg, MOCK_POOL);

    // S3 should NOT have been called at all (ListObjectsV2 etc.)
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('validates planningPrefix format and rejects path traversal', async () => {
    const msg = makeStageMessageWithPlanning('../../../etc/passwd');

    await expect(handleIntakeStage(msg, MOCK_POOL)).rejects.toThrow(PipelineError);
    await expect(handleIntakeStage(msg, MOCK_POOL)).rejects.toThrow('Invalid planningPrefix format');
  });

  it('validates planningPrefix matches UUID pattern', async () => {
    const msg = makeStageMessageWithPlanning('triggers/not-a-uuid/planning/');

    await expect(handleIntakeStage(msg, MOCK_POOL)).rejects.toThrow(PipelineError);
    await expect(handleIntakeStage(msg, MOCK_POOL)).rejects.toThrow('Invalid planningPrefix format');
  });

  it('throws PipelineError when S3 download fails', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('S3 access denied'));

    const msg = makeStageMessageWithPlanning();

    await expect(handleIntakeStage(msg, MOCK_POOL)).rejects.toThrow(PipelineError);
    await expect(handleIntakeStage(msg, MOCK_POOL)).rejects.toThrow('Failed to download planning artifacts');
  });

  it('tracks hasPlanningContext in analytics', async () => {
    // Return empty listing so planning download does no work
    mockS3Send.mockResolvedValueOnce({
      Contents: [],
      IsTruncated: false,
    });

    const msg = makeStageMessageWithPlanning();
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockTrack).toHaveBeenCalledWith(
      'pipeline_started',
      expect.objectContaining({
        hasPlanningContext: true,
      }),
    );
  });

  it('tracks hasPlanningContext false when planningPrefix absent', async () => {
    const msg = makeStageMessage(); // no planningPrefix
    await handleIntakeStage(msg, MOCK_POOL);

    expect(mockTrack).toHaveBeenCalledWith(
      'pipeline_started',
      expect.objectContaining({
        hasPlanningContext: false,
      }),
    );
  });
});

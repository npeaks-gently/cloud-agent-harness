import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSend = vi.fn();
const mockS3Client = { send: mockSend } as unknown as S3Client;

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class MockS3Client {
      constructor() {
        // no-op
      }
      send = mockSend;
    },
    PutObjectCommand: class MockPutObjectCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    GetObjectCommand: class MockGetObjectCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    ListObjectsV2Command: class MockListObjectsV2Command {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { writeFile, mkdir } from 'node:fs/promises';
import { downloadPlanningDir, uploadModifiedFiles } from '../entrypoint/s3-sync.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BUCKET = 'cah-dev-pipeline-bucket';
const RUN_ID = 'run-abc-123';
const TARGET_DIR = '/home/daytona/workspace';
const PHASE = '02';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('s3-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── downloadPlanningDir ────────────────────────────────────────────────

  describe('downloadPlanningDir', () => {
    it('lists objects under runs/{runId}/planning/ prefix and downloads each', async () => {
      const bodyContent = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      mockSend
        // First call: ListObjectsV2Command
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'runs/run-abc-123/planning/STATE.md' },
            { Key: 'runs/run-abc-123/planning/config.json' },
            { Key: 'runs/run-abc-123/planning/phases/01/01-01-PLAN.md' },
          ],
        })
        // Second call: GetObjectCommand for STATE.md
        .mockResolvedValueOnce({
          Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
        })
        // Third call: GetObjectCommand for config.json
        .mockResolvedValueOnce({
          Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
        })
        // Fourth call: GetObjectCommand for 01-01-PLAN.md
        .mockResolvedValueOnce({
          Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
        });

      const count = await downloadPlanningDir(BUCKET, RUN_ID, TARGET_DIR, mockS3Client);

      expect(count).toBe(3);
      // Verify ListObjectsV2 was called with correct prefix
      expect(mockSend).toHaveBeenCalledTimes(4);
      const listCmd = mockSend.mock.calls[0][0];
      expect(listCmd.input.Bucket).toBe(BUCKET);
      expect(listCmd.input.Prefix).toBe('runs/run-abc-123/planning/');

      // Verify files were written to correct paths
      expect(mkdir).toHaveBeenCalledTimes(3);
      expect(writeFile).toHaveBeenCalledTimes(3);
      expect(writeFile).toHaveBeenCalledWith(
        '/home/daytona/workspace/.planning/STATE.md',
        expect.any(Buffer),
      );
      expect(writeFile).toHaveBeenCalledWith(
        '/home/daytona/workspace/.planning/config.json',
        expect.any(Buffer),
      );
      expect(writeFile).toHaveBeenCalledWith(
        '/home/daytona/workspace/.planning/phases/01/01-01-PLAN.md',
        expect.any(Buffer),
      );
    });

    it('returns 0 and creates no files when S3 listing is empty', async () => {
      mockSend.mockResolvedValueOnce({ Contents: undefined });

      const count = await downloadPlanningDir(BUCKET, RUN_ID, TARGET_DIR, mockS3Client);

      expect(count).toBe(0);
      expect(mockSend).toHaveBeenCalledOnce();
      expect(writeFile).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    });

    it('creates intermediate directories for nested file paths', async () => {
      const bodyContent = new Uint8Array([49]); // "1"
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'runs/run-abc-123/planning/phases/02/deep/nested/file.md' },
          ],
        })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: vi.fn().mockResolvedValue(bodyContent) },
        });

      await downloadPlanningDir(BUCKET, RUN_ID, TARGET_DIR, mockS3Client);

      expect(mkdir).toHaveBeenCalledWith(
        '/home/daytona/workspace/.planning/phases/02/deep/nested',
        { recursive: true },
      );
    });

    it('skips objects with no Key or Body', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: undefined },
            { Key: 'runs/run-abc-123/planning/' }, // key equals prefix, no relative path
            { Key: 'runs/run-abc-123/planning/real.md' },
          ],
        })
        .mockResolvedValueOnce({
          Body: undefined, // no body
        });

      const count = await downloadPlanningDir(BUCKET, RUN_ID, TARGET_DIR, mockS3Client);

      expect(count).toBe(0);
    });
  });

  // ─── uploadModifiedFiles ────────────────────────────────────────────────

  describe('uploadModifiedFiles', () => {
    it('uploads each file to runs/{runId}/phases/{phase}/{path} with SHA256', async () => {
      mockSend.mockResolvedValue({});
      const files = [
        { path: 'SUMMARY.md', content: Buffer.from('# Summary') },
        { path: 'output.json', content: Buffer.from('{}') },
      ];

      const keys = await uploadModifiedFiles(BUCKET, RUN_ID, PHASE, files, mockS3Client);

      expect(keys).toEqual([
        'runs/run-abc-123/phases/02/SUMMARY.md',
        'runs/run-abc-123/phases/02/output.json',
      ]);
      expect(mockSend).toHaveBeenCalledTimes(2);

      const cmd1 = mockSend.mock.calls[0][0];
      expect(cmd1.input.Bucket).toBe(BUCKET);
      expect(cmd1.input.Key).toBe('runs/run-abc-123/phases/02/SUMMARY.md');
      expect(cmd1.input.ChecksumAlgorithm).toBe('SHA256');

      const cmd2 = mockSend.mock.calls[1][0];
      expect(cmd2.input.Key).toBe('runs/run-abc-123/phases/02/output.json');
      expect(cmd2.input.ChecksumAlgorithm).toBe('SHA256');
    });

    it('returns empty array when file list is empty', async () => {
      const keys = await uploadModifiedFiles(BUCKET, RUN_ID, PHASE, [], mockS3Client);

      expect(keys).toEqual([]);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

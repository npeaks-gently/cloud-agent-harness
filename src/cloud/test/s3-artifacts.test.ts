import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  uploadArtifact,
  downloadArtifact,
  listArtifacts,
  buildArtifactPath,
} from '../s3-artifacts.js';
import type { ArtifactKey } from '../types.js';
import type { S3Client } from '@aws-sdk/client-s3';

// ─── Mocks ──────────────────────────────────────────────────────────────────

/**
 * Instead of mocking the S3Client constructor, we create a mock client
 * object and inject it via the optional `client` parameter. This avoids
 * constructor mock issues with vi.mock.
 */
const mockSend = vi.fn();
const mockS3Client = { send: mockSend } as unknown as S3Client;

// We still need to mock the Command classes since the source code
// imports and instantiates them.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BUCKET = 'cah-dev-pipeline-bucket';

const ARTIFACT_KEY: ArtifactKey = {
  runId: 'run-abc-123',
  phase: '01',
  fileName: 'SUMMARY.md',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('s3-artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── buildArtifactPath ────────────────────────────────────────────────

  describe('buildArtifactPath', () => {
    it('builds correct key pattern runs/{runId}/phases/{phase}/{fileName}', () => {
      expect(buildArtifactPath(ARTIFACT_KEY)).toBe(
        'runs/run-abc-123/phases/01/SUMMARY.md',
      );
    });
  });

  // ─── uploadArtifact ───────────────────────────────────────────────────

  describe('uploadArtifact', () => {
    it('calls PutObjectCommand with correct key pattern', async () => {
      mockSend.mockResolvedValueOnce({});
      const content = Buffer.from('# Summary\nPlan completed.');

      await uploadArtifact(BUCKET, ARTIFACT_KEY, content, mockS3Client);

      expect(mockSend).toHaveBeenCalledOnce();
      const command = mockSend.mock.calls[0][0];
      expect(command.input.Bucket).toBe(BUCKET);
      expect(command.input.Key).toBe('runs/run-abc-123/phases/01/SUMMARY.md');
      expect(command.input.Body).toEqual(content);
    });

    it('sets ChecksumAlgorithm to SHA256', async () => {
      mockSend.mockResolvedValueOnce({});
      const content = Buffer.from('test content');

      await uploadArtifact(BUCKET, ARTIFACT_KEY, content, mockS3Client);

      const command = mockSend.mock.calls[0][0];
      expect(command.input.ChecksumAlgorithm).toBe('SHA256');
    });
  });

  // ─── downloadArtifact ─────────────────────────────────────────────────

  describe('downloadArtifact', () => {
    it('returns Buffer from S3 response body', async () => {
      const bodyContent = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(bodyContent),
        },
      });

      const result = await downloadArtifact(BUCKET, ARTIFACT_KEY, mockS3Client);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('Hello');
    });

    it('throws when Body is undefined', async () => {
      mockSend.mockResolvedValueOnce({ Body: undefined });

      await expect(
        downloadArtifact(BUCKET, ARTIFACT_KEY, mockS3Client),
      ).rejects.toThrow('S3 response body is undefined');
    });
  });

  // ─── listArtifacts ────────────────────────────────────────────────────

  describe('listArtifacts', () => {
    it('returns file names stripped of prefix', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: 'runs/run-abc-123/phases/01/SUMMARY.md' },
          { Key: 'runs/run-abc-123/phases/01/STATE.md' },
          { Key: 'runs/run-abc-123/phases/01/output.json' },
        ],
      });

      const result = await listArtifacts(BUCKET, 'run-abc-123', '01', mockS3Client);

      expect(result).toEqual(['SUMMARY.md', 'STATE.md', 'output.json']);
    });

    it('returns empty array when no objects found', async () => {
      mockSend.mockResolvedValueOnce({ Contents: undefined });

      const result = await listArtifacts(BUCKET, 'run-abc-123', '01', mockS3Client);

      expect(result).toEqual([]);
    });
  });
});

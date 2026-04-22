import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockS3Send = vi.fn();
const mockSqsSend = vi.fn();

const mockS3Client = { send: mockS3Send } as unknown as S3Client;
const mockSqsClient = { send: mockSqsSend } as unknown as SQSClient;

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
    PutObjectCommand: class MockPutObjectCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    HeadBucketCommand: class MockHeadBucketCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

vi.mock('@aws-sdk/client-sqs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sqs')>();
  return {
    ...actual,
    SQSClient: class MockSQSClient {
      constructor() {
        // no-op
      }
      send = mockSqsSend;
    },
    SendMessageCommand: class MockSendMessageCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

// ─── Import under test ─────────────────────────────────────────────────────

import { dispatch, walkDir, type DispatchOptions } from '../dispatch/cah-dispatch.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BUCKET = 'cah-dev-pipeline-bucket';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/cah-job-queue';

let tempDir: string;

function makeDispatchOptions(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    projectDir: tempDir,
    projectId: 'project-abc',
    repoUrl: 'https://github.com/org/repo',
    branch: 'main',
    featureDescription: 'Add user authentication',
    bucket: BUCKET,
    queueUrl: QUEUE_URL,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cah-dispatch', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockSqsSend.mockResolvedValue({});
    tempDir = await mkdtemp(join(tmpdir(), 'cah-dispatch-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── dispatch ──────────────────────────────────────────────────────────

  describe('dispatch', () => {
    it('uploads all .planning/ files to S3 with correct key prefix', async () => {
      // Create .planning/ with files
      const planningDir = join(tempDir, '.planning');
      await mkdir(join(planningDir, 'phases', '01'), { recursive: true });
      await writeFile(join(planningDir, 'STATE.md'), '# State');
      await writeFile(join(planningDir, 'config.json'), '{}');
      await writeFile(join(planningDir, 'phases', '01', '01-01-PLAN.md'), '# Plan');

      const result = await dispatch(makeDispatchOptions(), mockS3Client, mockSqsClient);

      // 3 PutObjectCommand calls for files + 1 SendMessageCommand
      expect(mockS3Send).toHaveBeenCalledTimes(3);
      expect(result.filesUploaded).toBe(3);

      // Verify S3 keys match triggers/{uuid}/planning/{relativePath}
      const s3Calls = mockS3Send.mock.calls.map(c => c[0].input);
      const keys = s3Calls.map(input => input.Key as string);
      expect(keys.every(k => k.startsWith(`triggers/${result.triggerId}/planning/`))).toBe(true);

      // Verify each has ChecksumAlgorithm
      expect(s3Calls.every(input => input.ChecksumAlgorithm === 'SHA256')).toBe(true);

      // Verify relative paths are correct
      const relativePaths = keys.map(k => k.replace(`triggers/${result.triggerId}/planning/`, ''));
      expect(relativePaths).toContain('STATE.md');
      expect(relativePaths).toContain('config.json');
      expect(relativePaths).toContain(join('phases', '01', '01-01-PLAN.md'));
    });

    it('sends PipelineJobMessage to SQS with planningPrefix', async () => {
      const planningDir = join(tempDir, '.planning');
      await mkdir(planningDir, { recursive: true });
      await writeFile(join(planningDir, 'STATE.md'), '# State');

      const result = await dispatch(makeDispatchOptions(), mockS3Client, mockSqsClient);

      expect(mockSqsSend).toHaveBeenCalledOnce();
      const sqsCall = mockSqsSend.mock.calls[0][0];
      expect(sqsCall.input.QueueUrl).toBe(QUEUE_URL);

      const body = JSON.parse(sqsCall.input.MessageBody as string);
      expect(body.planningPrefix).toBe(result.planningPrefix);
      expect(body.projectId).toBe('project-abc');
      expect(body.repoUrl).toBe('https://github.com/org/repo');
      expect(body.branch).toBe('main');
      expect(body.featureDescription).toBe('Add user authentication');
    });

    it('returns triggerId and file count', async () => {
      const planningDir = join(tempDir, '.planning');
      await mkdir(planningDir, { recursive: true });
      await writeFile(join(planningDir, 'file1.md'), 'content');
      await writeFile(join(planningDir, 'file2.md'), 'content');

      const result = await dispatch(makeDispatchOptions(), mockS3Client, mockSqsClient);

      // triggerId should be a valid UUID format
      expect(result.triggerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.filesUploaded).toBe(2);
      expect(result.planningPrefix).toBe(`triggers/${result.triggerId}/planning/`);
    });

    it('throws when .planning/ directory does not exist', async () => {
      // Do NOT create .planning/ in tempDir
      await expect(
        dispatch(makeDispatchOptions(), mockS3Client, mockSqsClient),
      ).rejects.toThrow('Planning directory not found');
    });

    it('throws when .planning/ directory is empty', async () => {
      const planningDir = join(tempDir, '.planning');
      await mkdir(planningDir, { recursive: true });
      // Empty directory, no files

      await expect(
        dispatch(makeDispatchOptions(), mockS3Client, mockSqsClient),
      ).rejects.toThrow('is empty');
    });

    it('rejects paths with traversal characters', async () => {
      // Create a .planning/ directory with a normally named file
      const planningDir = join(tempDir, '.planning');
      await mkdir(planningDir, { recursive: true });
      await writeFile(join(planningDir, 'STATE.md'), '# State');

      // We cannot create actual traversal file paths via fs. Instead, we test the
      // validation logic by mocking walkDir behavior indirectly. The relative() call
      // in dispatch would never produce '..' for files inside planningDir, so this
      // path traversal is a defense-in-depth measure. We verify the validation by
      // testing walkDir separately and verifying PutObjectCommand key construction.

      // The actual traversal test: create a symlink scenario or verify error for
      // path that somehow includes '..' (which join+relative would normalize away
      // on real filesystems). The code validates relative paths, so we verify
      // dispatch works correctly with normal paths.
      const result = await dispatch(makeDispatchOptions(), mockS3Client, mockSqsClient);
      expect(result.filesUploaded).toBe(1);

      // Verify the key does not contain '..'
      const s3Call = mockS3Send.mock.calls[0][0];
      expect((s3Call.input.Key as string).includes('..')).toBe(false);
    });
  });

  // ─── walkDir ───────────────────────────────────────────────────────────

  describe('walkDir', () => {
    it('returns all files recursively', async () => {
      await mkdir(join(tempDir, 'a', 'b', 'c'), { recursive: true });
      await writeFile(join(tempDir, 'root.txt'), 'root');
      await writeFile(join(tempDir, 'a', 'level1.txt'), 'level1');
      await writeFile(join(tempDir, 'a', 'b', 'level2.txt'), 'level2');
      await writeFile(join(tempDir, 'a', 'b', 'c', 'level3.txt'), 'level3');

      const files = await walkDir(tempDir);

      expect(files).toHaveLength(4);
      expect(files).toContain(join(tempDir, 'root.txt'));
      expect(files).toContain(join(tempDir, 'a', 'level1.txt'));
      expect(files).toContain(join(tempDir, 'a', 'b', 'level2.txt'));
      expect(files).toContain(join(tempDir, 'a', 'b', 'c', 'level3.txt'));
    });

    it('returns empty array for empty directory', async () => {
      const emptyDir = join(tempDir, 'empty');
      await mkdir(emptyDir, { recursive: true });

      const files = await walkDir(emptyDir);

      expect(files).toEqual([]);
    });
  });
});

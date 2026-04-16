/**
 * S3 context sync for Daytona sandbox entrypoint.
 *
 * Downloads the full .planning/ directory from S3 into the sandbox workspace
 * before agent execution, and uploads modified files back after completion.
 * Follows the same S3 client injection pattern as s3-artifacts.ts per D-16, D-17, D-19.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default AWS region per D-11. */
const DEFAULT_REGION = 'us-east-1';

// ─── Download ───────────────────────────────────────────────────────────────

/**
 * Downloads the full .planning/ directory from S3 into the sandbox workspace.
 *
 * Lists all objects under `runs/{runId}/planning/` and writes each to
 * `{targetDir}/.planning/{relativePath}`, creating intermediate directories
 * as needed.
 *
 * @param bucket - S3 bucket name
 * @param runId - Pipeline run ID for S3 key namespace
 * @param targetDir - Local directory to write files into (e.g., /home/daytona/workspace)
 * @param client - Optional S3Client for testability (creates one if not provided)
 * @returns Count of files successfully downloaded
 */
export async function downloadPlanningDir(
  bucket: string,
  runId: string,
  targetDir: string,
  client?: S3Client,
): Promise<number> {
  const s3 = client ?? new S3Client({ region: DEFAULT_REGION });
  const prefix = `runs/${runId}/planning/`;

  let continuationToken: string | undefined;
  let count = 0;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      const key = obj.Key;
      if (!key || key.length <= prefix.length) continue;

      const relativePath = key.slice(prefix.length);
      const fullPath = join(targetDir, '.planning', relativePath);

      const getResponse = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );

      if (!getResponse.Body) continue;

      // Only create directories when we know we'll write the file (WR-05)
      await mkdir(dirname(fullPath), { recursive: true });
      const bytes = await getResponse.Body.transformToByteArray();
      await writeFile(fullPath, Buffer.from(bytes));
      count++;
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return count;
}

// ─── Upload ─────────────────────────────────────────────────────────────────

/**
 * Uploads modified files to S3 after agent execution completes.
 *
 * Each file is uploaded to `runs/{runId}/phases/{phase}/{path}` with
 * SHA256 checksum verification, following the same pattern as s3-artifacts.ts.
 *
 * @param bucket - S3 bucket name
 * @param runId - Pipeline run ID for S3 key namespace
 * @param phase - Phase identifier (e.g., "01", "02")
 * @param files - Array of file objects with relative path and content buffer
 * @param client - Optional S3Client for testability (creates one if not provided)
 * @returns Array of uploaded S3 keys
 */
export async function uploadModifiedFiles(
  bucket: string,
  runId: string,
  phase: string,
  files: Array<{ path: string; content: Buffer }>,
  client?: S3Client,
): Promise<string[]> {
  const s3 = client ?? new S3Client({ region: DEFAULT_REGION });
  const uploadedKeys: string[] = [];

  for (const file of files) {
    const key = `runs/${runId}/phases/${phase}/${file.path}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.content,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    uploadedKeys.push(key);
  }

  return uploadedKeys;
}

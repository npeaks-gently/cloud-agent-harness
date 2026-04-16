/**
 * S3 artifact upload/download with checksum verification.
 *
 * Pure async functions for storing and retrieving pipeline artifacts
 * in S3 using the key path pattern: runs/{runId}/phases/{phase}/{fileName}
 * per D-12.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { ArtifactKey } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default AWS region per D-11. */
const DEFAULT_REGION = 'us-east-1';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Builds the S3 object key from structured artifact key components.
 * Pattern: runs/{runId}/phases/{phase}/{fileName} per D-12.
 */
export function buildArtifactPath(key: ArtifactKey): string {
  return `runs/${key.runId}/phases/${key.phase}/${key.fileName}`;
}

// ─── Upload ─────────────────────────────────────────────────────────────────

/**
 * Uploads an artifact to S3 with SHA256 checksum verification (Pitfall 6).
 *
 * @param bucket - S3 bucket name
 * @param key - Structured artifact key
 * @param content - File content as Buffer
 * @param client - Optional S3Client for testability (creates one if not provided)
 */
export async function uploadArtifact(
  bucket: string,
  key: ArtifactKey,
  content: Buffer,
  client?: S3Client,
): Promise<void> {
  const s3 = client ?? new S3Client({ region: DEFAULT_REGION });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: buildArtifactPath(key),
      Body: content,
      ChecksumAlgorithm: 'SHA256',
    }),
  );
}

// ─── Download ───────────────────────────────────────────────────────────────

/**
 * Downloads an artifact from S3.
 *
 * @param bucket - S3 bucket name
 * @param key - Structured artifact key
 * @param client - Optional S3Client for testability
 * @returns File content as Buffer
 * @throws Error if the S3 response body is undefined
 */
export async function downloadArtifact(
  bucket: string,
  key: ArtifactKey,
  client?: S3Client,
): Promise<Buffer> {
  const s3 = client ?? new S3Client({ region: DEFAULT_REGION });

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: buildArtifactPath(key),
    }),
  );

  if (!response.Body) {
    throw new Error(
      `S3 response body is undefined for key: ${buildArtifactPath(key)}`,
    );
  }

  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

// ─── List ───────────────────────────────────────────────────────────────────

/**
 * Lists artifact file names for a given pipeline run and phase.
 *
 * @param bucket - S3 bucket name
 * @param runId - Pipeline run ID
 * @param phase - Phase identifier
 * @param client - Optional S3Client for testability
 * @returns Array of file names (prefix stripped)
 */
export async function listArtifacts(
  bucket: string,
  runId: string,
  phase: string,
  client?: S3Client,
): Promise<string[]> {
  const s3 = client ?? new S3Client({ region: DEFAULT_REGION });
  const prefix = `runs/${runId}/phases/${phase}/`;

  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    }),
  );

  if (!response.Contents) {
    return [];
  }

  return response.Contents
    .map((obj) => obj.Key ?? '')
    .filter((key) => key.length > prefix.length)
    .map((key) => key.slice(prefix.length));
}

/**
 * CLI dispatch script for uploading local .planning/ artifacts to S3
 * and triggering the cloud pipeline via SQS.
 *
 * Usage: npx tsx src/cloud/dispatch/cah-dispatch.ts \
 *   --project-id <id> --repo-url <url> --branch <branch> \
 *   --description "Feature description" \
 *   [--project-dir <path>] [--bucket <bucket>] [--queue-url <url>]
 *
 * The script:
 * 1. Validates AWS credentials are available (Pitfall 6)
 * 2. Generates a triggerId (UUID) for S3 key namespacing
 * 3. Walks the local .planning/ directory
 * 4. Uploads each file to s3://bucket/triggers/{triggerId}/planning/{relativePath}
 * 5. Sends a PipelineJobMessage to SQS with planningPrefix field
 * 6. Prints the triggerId for tracking
 *
 * @see D-11 Hybrid S3 upload approach
 * @see D-12 cah-dispatch CLI script
 * @see D-13 PipelineJobMessage.planningPrefix
 * @see D-14 Pre-run S3 key structure
 */

import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_REGION = 'us-east-1';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for the dispatch function. */
export interface DispatchOptions {
  /** Path to the project directory containing .planning/ */
  projectDir: string;
  /** Project identifier */
  projectId: string;
  /** Git repository URL */
  repoUrl: string;
  /** Branch name */
  branch: string;
  /** Human-readable feature description */
  featureDescription: string;
  /** S3 bucket name */
  bucket: string;
  /** SQS queue URL */
  queueUrl: string;
}

/** Result of a successful dispatch. */
export interface DispatchResult {
  /** Generated trigger ID (UUID) */
  triggerId: string;
  /** S3 key prefix where artifacts were uploaded */
  planningPrefix: string;
  /** Number of files uploaded */
  filesUploaded: number;
}

// ─── Directory walker ───────────────────────────────────────────────────────

/**
 * Recursively walks a directory and returns all file paths.
 *
 * @param dir - Directory to walk
 * @returns Array of absolute file paths
 */
export async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await walkDir(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Uploads .planning/ to S3 and sends a PipelineJobMessage to SQS.
 *
 * @param options - Dispatch configuration
 * @param s3Client - Optional S3Client for testability
 * @param sqsClient - Optional SQSClient for testability
 * @returns Dispatch result with triggerId and upload count
 * @throws {Error} When .planning/ directory does not exist or AWS calls fail
 */
export async function dispatch(
  options: DispatchOptions,
  s3Client?: S3Client,
  sqsClient?: SQSClient,
): Promise<DispatchResult> {
  const s3 = s3Client ?? new S3Client({ region: DEFAULT_REGION });
  const sqs = sqsClient ?? new SQSClient({ region: DEFAULT_REGION });
  const triggerId = randomUUID();
  const planningPrefix = `triggers/${triggerId}/planning/`;

  // Step 1: Validate .planning/ directory exists
  const planningDir = join(options.projectDir, '.planning');
  const planningDirStat = await stat(planningDir).catch(() => null);
  if (!planningDirStat?.isDirectory()) {
    throw new Error(
      `Planning directory not found at ${planningDir}. Run /gsd-discuss-phase or /gsd-new-project first.`,
    );
  }

  // Step 2: Walk .planning/ and upload each file to S3
  const files = await walkDir(planningDir);
  if (files.length === 0) {
    throw new Error(`Planning directory ${planningDir} is empty. No artifacts to upload.`);
  }

  for (const filePath of files) {
    const relativePath = relative(planningDir, filePath);
    // Validate path: reject traversal characters (T-04-09)
    if (relativePath.includes('..')) {
      throw new Error(`Invalid file path with traversal: ${relativePath}`);
    }
    const key = `${planningPrefix}${relativePath}`;
    const content = await readFile(filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: content,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  }

  // Step 3: Send PipelineJobMessage to SQS with planningPrefix
  const message = {
    projectId: options.projectId,
    repoUrl: options.repoUrl,
    branch: options.branch,
    featureDescription: options.featureDescription,
    planningPrefix,
  };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: options.queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );

  console.log(JSON.stringify({
    level: 'info',
    message: 'Pipeline dispatched',
    triggerId,
    planningPrefix,
    filesUploaded: files.length,
    queueUrl: options.queueUrl,
  }));

  return { triggerId, planningPrefix, filesUploaded: files.length };
}

// ─── CLI entry point ────────────────────────────────────────────────────────

/**
 * Parses CLI arguments and runs dispatch.
 * Only executes when script is run directly (not imported).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const projectId = getArg('--project-id');
  const repoUrl = getArg('--repo-url');
  const branch = getArg('--branch');
  const featureDescription = getArg('--description');
  const projectDir = getArg('--project-dir') ?? process.cwd();
  const bucket = getArg('--bucket') ?? process.env.CAH_ARTIFACT_BUCKET;
  const queueUrl = getArg('--queue-url') ?? process.env.CAH_JOB_QUEUE_URL;

  if (!projectId || !repoUrl || !branch || !featureDescription) {
    console.error('Usage: cah-dispatch --project-id <id> --repo-url <url> --branch <branch> --description "..."');
    console.error('Required: --project-id, --repo-url, --branch, --description');
    console.error('Optional: --project-dir (default: cwd), --bucket (or CAH_ARTIFACT_BUCKET env), --queue-url (or CAH_JOB_QUEUE_URL env)');
    process.exit(1);
  }

  if (!bucket) {
    console.error('Error: S3 bucket not specified. Set CAH_ARTIFACT_BUCKET env var or pass --bucket.');
    process.exit(1);
  }

  if (!queueUrl) {
    console.error('Error: SQS queue URL not specified. Set CAH_JOB_QUEUE_URL env var or pass --queue-url.');
    process.exit(1);
  }

  // Pitfall 6: Check AWS credentials early (T-04-11)
  try {
    const s3 = new S3Client({ region: DEFAULT_REGION });
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CredentialsProviderError') || message.includes('Could not load credentials')) {
      console.error('Error: AWS credentials not found. Set AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.');
      process.exit(1);
    }
    // Other errors (e.g., bucket not found) will surface during dispatch
  }

  const result = await dispatch({
    projectDir,
    projectId,
    repoUrl,
    branch,
    featureDescription,
    bucket,
    queueUrl,
  });

  console.log(`Dispatch complete. Trigger ID: ${result.triggerId}`);
  console.log(`Files uploaded: ${result.filesUploaded}`);
  console.log(`Planning prefix: ${result.planningPrefix}`);
}

// Run main only when executed directly (standard ESM direct-run detection)
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

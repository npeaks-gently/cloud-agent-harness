/**
 * Boundary 1 verification: CLI dispatch → S3
 *
 * Calls dispatch() with the real S3 bucket but a no-op SQS client
 * (to avoid triggering the pipeline). Verifies files land in S3,
 * then cleans up.
 *
 * Usage: npx tsx scripts/verify-boundary-1.ts
 */

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { dispatch } from '../src/cloud/dispatch/cah-dispatch.js';

const BUCKET = 'cah-dev-pipeline-bucket';
const REGION = 'us-east-1';

// No-op SQS client — captures the message without sending it
const sqsCapture: { body?: string } = {};
const noopSqsClient = {
  send: async (cmd: unknown) => {
    const input = (cmd as { input: Record<string, unknown> }).input;
    sqsCapture.body = input.MessageBody as string;
    return { MessageId: 'noop-captured' };
  },
} as unknown as SQSClient;

async function main(): Promise<void> {
  console.log('=== Boundary 1: CLI → S3 (live AWS) ===\n');

  // 1. Create temp .planning/ with representative files
  const tempDir = await mkdtemp(join(tmpdir(), 'cah-boundary1-'));
  const planningDir = join(tempDir, '.planning');
  await mkdir(join(planningDir, 'phases', '01'), { recursive: true });
  await writeFile(join(planningDir, 'STATE.md'), '# Verification Test State');
  await writeFile(join(planningDir, 'config.json'), '{"test": true}');
  await writeFile(join(planningDir, 'phases', '01', '01-01-PLAN.md'), '# Test Plan');

  console.log(`Temp project dir: ${tempDir}`);
  console.log('Files created: STATE.md, config.json, phases/01/01-01-PLAN.md\n');

  // 2. Dispatch with real S3, no-op SQS
  const s3 = new S3Client({ region: REGION });
  let result;
  try {
    result = await dispatch(
      {
        projectDir: tempDir,
        projectId: 'boundary-test',
        repoUrl: 'https://github.com/test/verify',
        branch: 'main',
        featureDescription: 'Boundary 1 verification test',
        bucket: BUCKET,
        queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/noop',
      },
      s3,
      noopSqsClient,
    );
  } catch (err) {
    console.error('FAIL: dispatch() threw:', err);
    await rm(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  console.log('--- Dispatch result ---');
  console.log(`  triggerId:      ${result.triggerId}`);
  console.log(`  planningPrefix: ${result.planningPrefix}`);
  console.log(`  filesUploaded:  ${result.filesUploaded}`);

  // 3. Show captured SQS message body
  console.log('\n--- Captured SQS message body ---');
  if (sqsCapture.body) {
    console.log(JSON.stringify(JSON.parse(sqsCapture.body), null, 2));
  }

  // 4. Verify files in S3
  console.log('\n--- S3 listing ---');
  const listResponse = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: result.planningPrefix,
    }),
  );

  const keys = (listResponse.Contents ?? []).map(obj => obj.Key).filter(Boolean);
  if (keys.length === 0) {
    console.error('FAIL: No objects found in S3 under prefix', result.planningPrefix);
    process.exit(1);
  }

  for (const key of keys) {
    console.log(`  s3://${BUCKET}/${key}`);
  }

  // 5. Check expectations
  console.log('\n--- Checks ---');
  const expectedSuffixes = ['STATE.md', 'config.json', 'phases/01/01-01-PLAN.md'];
  let allPassed = true;

  for (const suffix of expectedSuffixes) {
    const found = keys.some(k => k?.endsWith(suffix));
    const status = found ? 'PASS' : 'FAIL';
    if (!found) allPassed = false;
    console.log(`  [${status}] ${suffix} exists in S3`);
  }

  const countMatch = keys.length === result.filesUploaded;
  console.log(`  [${countMatch ? 'PASS' : 'FAIL'}] S3 object count (${keys.length}) matches filesUploaded (${result.filesUploaded})`);
  if (!countMatch) allPassed = false;

  const prefixCorrect = keys.every(k => k?.startsWith(`triggers/${result.triggerId}/planning/`));
  console.log(`  [${prefixCorrect ? 'PASS' : 'FAIL'}] All keys start with triggers/{triggerId}/planning/`);
  if (!prefixCorrect) allPassed = false;

  // 6. Cleanup S3
  console.log('\n--- Cleanup ---');
  if (keys.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: {
          Objects: keys.map(Key => ({ Key: Key! })),
        },
      }),
    );
    console.log(`  Deleted ${keys.length} objects from S3`);
  }
  await rm(tempDir, { recursive: true, force: true });
  console.log('  Deleted temp directory');

  // 7. Verdict
  console.log(`\n=== Boundary 1: ${allPassed ? 'PASS' : 'FAIL'} ===`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

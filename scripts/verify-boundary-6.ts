/**
 * Boundary 6 verification: Intake → S3 (planningPrefix download)
 *
 * Simulates the full dispatch→intake S3 flow:
 * 1. Uploads files to triggers/{triggerId}/planning/ (like dispatch)
 * 2. Runs the same list+copy logic as intake.ts:89-167
 * 3. Verifies files land at runs/{runId}/planning/
 * 4. Cleans up both prefixes
 *
 * Usage: NODE_OPTIONS="" npx tsx scripts/verify-boundary-6.ts
 */

import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const BUCKET = 'cah-dev-pipeline-bucket';
const REGION = 'us-east-1';

async function main(): Promise<void> {
  console.log('=== Boundary 6: Intake → S3 planningPrefix download (live AWS) ===\n');

  const s3 = new S3Client({ region: REGION });
  const triggerId = randomUUID();
  const runId = randomUUID();
  const planningPrefix = `triggers/${triggerId}/planning/`;
  const runPrefix = `runs/${runId}/planning/`;

  const testFiles: Record<string, string> = {
    'STATE.md': '# Test State',
    'config.json': '{"test": true}',
    'phases/01/01-01-PLAN.md': '# Test Plan',
  };

  try {
    // 1. Upload files to trigger prefix (simulating dispatch)
    console.log('--- Step 1: Upload to trigger prefix (dispatch side) ---');
    for (const [relativePath, content] of Object.entries(testFiles)) {
      const key = `${planningPrefix}${relativePath}`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: Buffer.from(content),
        ChecksumAlgorithm: 'SHA256',
      }));
      console.log(`  Uploaded: ${key}`);
    }

    // 2. Run intake's list+copy logic (same as intake.ts:100-149)
    console.log('\n--- Step 2: List + copy (intake side) ---');

    // Validate prefix format (same regex as intake.ts:92)
    const prefixPattern = /^triggers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/planning\/$/;
    if (!prefixPattern.test(planningPrefix)) {
      console.error('FAIL: planningPrefix rejected by regex');
      process.exit(1);
    }
    console.log('  Prefix passes regex validation');

    let continuationToken: string | undefined;
    let copiedCount = 0;

    do {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: planningPrefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of response.Contents ?? []) {
        const key = obj.Key;
        if (!key || key.length <= planningPrefix.length) continue;

        const relativePath = key.slice(planningPrefix.length);
        const destKey = `${runPrefix}${relativePath}`;

        const getResponse = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        if (!getResponse.Body) continue;

        const bytes = await getResponse.Body.transformToByteArray();
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: destKey,
          Body: Buffer.from(bytes),
          ChecksumAlgorithm: 'SHA256',
        }));
        console.log(`  Copied: ${key} → ${destKey}`);
        copiedCount++;
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    console.log(`  Total copied: ${copiedCount}`);

    // 3. Verify files at run prefix
    console.log('\n--- Step 3: Verify at run prefix ---');
    const verifyResponse = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: runPrefix,
    }));
    const runKeys = (verifyResponse.Contents ?? []).map(obj => obj.Key).filter(Boolean);

    console.log('\n--- Checks ---');
    let allPassed = true;

    // Check: correct number of files copied
    const countMatch = copiedCount === Object.keys(testFiles).length;
    console.log(`  [${countMatch ? 'PASS' : 'FAIL'}] Copied count (${copiedCount}) matches source count (${Object.keys(testFiles).length})`);
    if (!countMatch) allPassed = false;

    // Check: each file exists at run prefix
    for (const relativePath of Object.keys(testFiles)) {
      const expectedKey = `${runPrefix}${relativePath}`;
      const found = runKeys.includes(expectedKey);
      console.log(`  [${found ? 'PASS' : 'FAIL'}] ${relativePath} exists at run prefix`);
      if (!found) allPassed = false;
    }

    // Check: content preserved (spot check STATE.md)
    const stateResponse = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `${runPrefix}STATE.md`,
    }));
    const stateContent = await stateResponse.Body?.transformToByteArray();
    const contentMatch = stateContent && Buffer.from(stateContent).toString() === testFiles['STATE.md'];
    console.log(`  [${contentMatch ? 'PASS' : 'FAIL'}] STATE.md content preserved after copy`);
    if (!contentMatch) allPassed = false;

    // Check: trigger prefix keys don't appear in run prefix (clean separation)
    const noTriggerLeakage = runKeys.every(k => !k?.startsWith('triggers/'));
    console.log(`  [${noTriggerLeakage ? 'PASS' : 'FAIL'}] No trigger prefix leakage into run prefix`);
    if (!noTriggerLeakage) allPassed = false;

    console.log(`\n=== Boundary 6: ${allPassed ? 'PASS' : 'FAIL'} ===`);
    if (!allPassed) process.exit(1);
  } finally {
    // 4. Cleanup both prefixes
    console.log('\n--- Cleanup ---');
    for (const prefix of [planningPrefix, runPrefix]) {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
      const keys = (list.Contents ?? []).map(obj => obj.Key).filter(Boolean);
      if (keys.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: keys.map(Key => ({ Key: Key! })) },
        }));
        console.log(`  Deleted ${keys.length} objects under ${prefix}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

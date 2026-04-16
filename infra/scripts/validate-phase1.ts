#!/usr/bin/env npx ts-node
/**
 * Phase 1 End-to-End Validation Script
 *
 * Validates all INFRA requirements against deployed AWS infrastructure:
 * - INFRA-02: Postgres accepts connections, schema is queryable
 * - INFRA-03: S3 artifacts round-trip (upload, download, verify identical)
 * - INFRA-04: Daytona workspace lifecycle (create, execute, teardown)
 * - INFRA-05: SQS message send/receive/delete
 *
 * Prerequisites:
 *   1. CDK stack deployed: cd infra && npx cdk deploy
 *   2. Schema initialized: psql "$DATABASE_URL" -f scripts/init-db-schema.sql
 *   3. Environment variables set (see below)
 *
 * Required environment variables:
 *   DATABASE_URL     -- Postgres connection string (from Secrets Manager)
 *   S3_BUCKET        -- S3 bucket name (from CDK output BucketName)
 *   SQS_QUEUE_URL    -- SQS queue URL (from CDK output QueueUrl)
 *   DAYTONA_API_KEY  -- Daytona API key
 *   DAYTONA_TARGET   -- Daytona target (default: us)
 *   ANTHROPIC_API_KEY -- Claude API key (for agent task inside sandbox)
 *   REPO_URL         -- Git repo URL for sandbox to clone
 *
 * Usage: npx ts-node --esm scripts/validate-phase1.ts
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load infra/.env (one level up from this script)
config({ path: resolve(import.meta.dirname ?? __dirname, '..', '.env') });

import { createDbPool, insertPipelineRun, getPipelineRun } from '../../src/cloud/postgres-client.js';
import { uploadArtifact, downloadArtifact, listArtifacts } from '../../src/cloud/s3-artifacts.js';
import { DaytonaClient } from '../../src/cloud/daytona-client.js';
import { SqsConsumer } from '../../src/cloud/sqs-consumer.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { ArtifactKey, PipelineJobMessage } from '../../src/cloud/types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ValidationResult {
  requirement: string;
  passed: boolean;
  message: string;
}

// ─── Environment validation ────────────────────────────────────────────────

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'S3_BUCKET',
  'SQS_QUEUE_URL',
  'DAYTONA_API_KEY',
  'ANTHROPIC_API_KEY',
  'REPO_URL',
] as const;

function validateEnvironment(): boolean {
  let allPresent = true;

  for (const name of REQUIRED_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      // T-03-01: Never log credential values -- only log presence
      console.log(`  ${name}: [SET]`);
    } else {
      console.log(`  ${name}: [MISSING]`);
      allPresent = false;
    }
  }

  // DAYTONA_TARGET is optional with a default
  const target = process.env['DAYTONA_TARGET'];
  console.log(`  DAYTONA_TARGET: ${target ? '[SET]' : '[DEFAULT: us]'}`);

  return allPresent;
}

// ─── Step 2: INFRA-02 -- Postgres connectivity and schema ──────────────────

async function validatePostgres(): Promise<ValidationResult> {
  const pool = createDbPool(process.env['DATABASE_URL']!);

  try {
    // Insert a test pipeline run
    const id = await insertPipelineRun(pool, 'validate-phase1', 5, { validation: true });
    console.log(`  Inserted pipeline run: ${id}`);

    // Read it back
    const run = await getPipelineRun(pool, id);

    if (!run) {
      return {
        requirement: 'INFRA-02',
        passed: false,
        message: 'Pipeline run not found after insert',
      };
    }

    if (run.projectId !== 'validate-phase1') {
      return {
        requirement: 'INFRA-02',
        passed: false,
        message: `Expected projectId 'validate-phase1', got '${run.projectId}'`,
      };
    }

    if (run.phaseTotal !== 5) {
      return {
        requirement: 'INFRA-02',
        passed: false,
        message: `Expected phaseTotal 5, got ${run.phaseTotal}`,
      };
    }

    console.log(`  Read back pipeline run: projectId=${run.projectId}, phaseTotal=${run.phaseTotal}`);

    // Clean up test data
    await pool.query('DELETE FROM pipeline_runs WHERE project_id = $1', ['validate-phase1']);
    console.log('  Cleaned up test data');

    return {
      requirement: 'INFRA-02',
      passed: true,
      message: 'Postgres connection + insert/query successful',
    };
  } finally {
    try {
      await pool.end();
    } catch {
      // best-effort pool teardown
    }
  }
}

// ─── Step 3: INFRA-03 -- S3 artifact round-trip ────────────────────────────

async function validateS3(): Promise<ValidationResult> {
  const bucket = process.env['S3_BUCKET']!;
  const content = Buffer.from('Phase 1 validation artifact content ' + Date.now());
  const key: ArtifactKey = {
    runId: 'validate-phase1',
    phase: '01',
    fileName: 'test-artifact.txt',
  };

  // Upload
  await uploadArtifact(bucket, key, content);
  console.log('  Uploaded test artifact');

  // Download
  const downloaded = await downloadArtifact(bucket, key);
  console.log('  Downloaded test artifact');

  // Verify content match
  if (!downloaded.equals(content)) {
    return {
      requirement: 'INFRA-03',
      passed: false,
      message: 'Downloaded content does not match uploaded content',
    };
  }
  console.log('  Content match verified');

  // List artifacts
  const files = await listArtifacts(bucket, 'validate-phase1', '01');
  console.log(`  Listed artifacts: ${JSON.stringify(files)}`);

  if (!files.includes('test-artifact.txt')) {
    return {
      requirement: 'INFRA-03',
      passed: false,
      message: `Expected 'test-artifact.txt' in artifact list, got: ${JSON.stringify(files)}`,
    };
  }

  return {
    requirement: 'INFRA-03',
    passed: true,
    message: 'S3 artifact round-trip verified (upload, download, list, content match)',
  };
}

// ─── Step 4: INFRA-05 -- SQS send/receive/delete ──────────────────────────

async function validateSqs(): Promise<ValidationResult> {
  const queueUrl = process.env['SQS_QUEUE_URL']!;

  // Send a test message
  const sqsClient = new SQSClient({ region: 'us-east-1' });
  const testMessage: PipelineJobMessage = {
    projectId: 'validate-phase1',
    repoUrl: 'https://github.com/test/repo',
    branch: 'main',
    featureDescription: 'Phase 1 validation',
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(testMessage),
    }),
  );
  console.log('  Sent test message to SQS');

  // Receive via consumer (use short wait to avoid blocking)
  const consumer = new SqsConsumer({ queueUrl, waitTimeSeconds: 5 });
  const result = await consumer.receiveMessage();

  if (!result) {
    return {
      requirement: 'INFRA-05',
      passed: false,
      message: 'No message received from SQS queue',
    };
  }

  console.log(`  Received message: projectId=${result.message.projectId}`);

  if (result.message.projectId !== 'validate-phase1') {
    return {
      requirement: 'INFRA-05',
      passed: false,
      message: `Expected projectId 'validate-phase1', got '${result.message.projectId}'`,
    };
  }

  // Delete the message
  await consumer.deleteMessage(result.receiptHandle);
  console.log('  Deleted message from queue');

  return {
    requirement: 'INFRA-05',
    passed: true,
    message: 'SQS send/receive/delete successful',
  };
}

// ─── Step 5: INFRA-04 -- Daytona workspace lifecycle ───────────────────────

async function validateDaytona(): Promise<ValidationResult> {
  const apiKey = process.env['DAYTONA_API_KEY']!;
  const target = process.env['DAYTONA_TARGET'] ?? 'us';
  const repoUrl = process.env['REPO_URL']!;
  const anthropicKey = process.env['ANTHROPIC_API_KEY']!;

  const client = new DaytonaClient({ apiKey, target });

  const result = await client.executeTask({
    repoUrl,
    branch: 'main',
    envVars: { ANTHROPIC_API_KEY: anthropicKey },
    command: 'echo "Phase 1 validation: Daytona workspace lifecycle test" && node --version',
  });

  console.log(`  Exit code: ${result.exitCode}`);
  console.log(`  Duration: ${result.durationMs}ms`);
  console.log(`  Output: ${result.stdout.trim()}`);

  if (result.exitCode !== 0) {
    return {
      requirement: 'INFRA-04',
      passed: false,
      message: `Sandbox command exited with code ${result.exitCode}`,
    };
  }

  if (!result.stdout.includes('Phase 1 validation')) {
    return {
      requirement: 'INFRA-04',
      passed: false,
      message: `Expected stdout to contain 'Phase 1 validation', got: ${result.stdout.trim()}`,
    };
  }

  return {
    requirement: 'INFRA-04',
    passed: true,
    message: 'Daytona workspace lifecycle (create, clone, execute, teardown) successful',
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Phase 1 End-to-End Validation ===\n');

  // Step 1: Validate environment variables
  console.log('Step 1: Validating environment variables...');
  const envValid = validateEnvironment();

  if (!envValid) {
    console.log('\n[FAIL] Missing required environment variables. Set them and retry.');
    process.exit(1);
  }

  console.log('  All required environment variables present.\n');

  const results: ValidationResult[] = [];

  // Step 2: INFRA-02 -- Postgres
  console.log('Step 2: INFRA-02 -- Postgres connectivity and schema...');
  try {
    const result = await validatePostgres();
    results.push(result);
    console.log(`  [${result.passed ? 'PASS' : 'FAIL'}] INFRA-02: ${result.message}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ requirement: 'INFRA-02', passed: false, message });
    console.log(`  [FAIL] INFRA-02: ${message}\n`);
  }

  // Step 3: INFRA-03 -- S3
  console.log('Step 3: INFRA-03 -- S3 artifact round-trip...');
  try {
    const result = await validateS3();
    results.push(result);
    console.log(`  [${result.passed ? 'PASS' : 'FAIL'}] INFRA-03: ${result.message}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ requirement: 'INFRA-03', passed: false, message });
    console.log(`  [FAIL] INFRA-03: ${message}\n`);
  }

  // Step 4: INFRA-05 -- SQS
  console.log('Step 4: INFRA-05 -- SQS send/receive/delete...');
  try {
    const result = await validateSqs();
    results.push(result);
    console.log(`  [${result.passed ? 'PASS' : 'FAIL'}] INFRA-05: ${result.message}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ requirement: 'INFRA-05', passed: false, message });
    console.log(`  [FAIL] INFRA-05: ${message}\n`);
  }

  // Step 5: INFRA-04 -- Daytona
  console.log('Step 5: INFRA-04 -- Daytona workspace lifecycle...');
  try {
    const result = await validateDaytona();
    results.push(result);
    console.log(`  [${result.passed ? 'PASS' : 'FAIL'}] INFRA-04: ${result.message}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ requirement: 'INFRA-04', passed: false, message });
    console.log(`  [FAIL] INFRA-04: ${message}\n`);
  }

  // Summary
  console.log('=== Validation Summary ===\n');

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log('| Requirement | Status | Details |');
  console.log('|-------------|--------|---------|');
  for (const r of results) {
    console.log(`| ${r.requirement} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.message} |`);
  }

  console.log(`\nPassed: ${passed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log(`\nFailed requirements: ${failed.map((r) => r.requirement).join(', ')}`);
    process.exit(1);
  }

  console.log('\nAll validations passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

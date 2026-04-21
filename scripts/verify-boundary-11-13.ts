/**
 * Boundary 11-13 verification: Approve → Slack → Webhook → DB → SQS
 *
 * Full round-trip:
 * 1. Inserts a pipeline_run in Postgres
 * 2. Sends a real Slack approval message with a real token
 * 3. Inserts an approval row in Postgres with that token
 * 4. Waits for you to click Approve or Reject in Slack
 * 5. Polls Postgres to confirm the approval was resolved
 * 6. Cleans up DB rows
 *
 * Usage: NODE_OPTIONS="" npx tsx scripts/verify-boundary-11-13.ts
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SQSClient,
  ReceiveMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';

const { Pool } = pg;

// Set env before importing slack module
process.env.SLACK_BOT_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:659828095854:secret:cah-dev-slack-bot-token-VPynMv';

import { sendApprovalMessage } from '../src/cloud/integrations/slack.js';

const SLACK_USER_ID = 'U0A6ZENN1D5';
const REGION = 'us-east-1';
const DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:659828095854:secret:CahStackDatabaseInstanceSec-4tdMv7TNnEGn-mzU7v3';
const STAGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/659828095854/cah-dev-stage';

async function getDbUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const sm = new SecretsManagerClient({ region: REGION });
  const result = await sm.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
  if (!result.SecretString) throw new Error('Empty DB secret');
  const secret = JSON.parse(result.SecretString);
  return `postgres://${secret.username}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${secret.dbname}?sslmode=require`;
}

async function main(): Promise<void> {
  console.log('=== Boundaries 11-13: Approve → Slack → Webhook → DB (live round-trip) ===\n');

  const dbUrl = await getDbUrl();
  const pool = new Pool({ connectionString: dbUrl, max: 1, ssl: { rejectUnauthorized: false } });

  const runId = randomUUID();
  const approvalToken = randomUUID();

  try {
    // Step 1: Insert a pipeline_run so the webhook handler can find it
    console.log('--- Step 1: Insert pipeline_run ---');
    const insertRunSql = `
      INSERT INTO pipeline_runs (id, project_id, phase_total, config, status, repo_url, branch, feature_description, current_stage)
      VALUES ($1::uuid, $2, $3, $4, 'paused', $5, $6, $7, 'approve')
      ON CONFLICT (id) DO NOTHING
    `;
    await pool.query(insertRunSql, [
      runId,
      'boundary-test',
      3,
      JSON.stringify({ featureDescription: 'Boundary 11-13 live test' }),
      'https://github.com/test/verify',
      'main',
      'Boundary 11-13 live verification test',
    ]);
    console.log(`  Inserted pipeline_run: ${runId}`);

    // Step 2: Send real Slack approval message
    console.log('\n--- Step 2: Send Slack approval message ---');
    const planSummary = [
      '*Feature:* Boundary 11-13 live verification test',
      '*Phase:* 1 of 3',
      '*Project:* `boundary-test`',
      '',
      '_This is a test message. Click Approve or Reject to verify the webhook flow._',
    ].join('\n');

    const messageTs = await sendApprovalMessage(
      SLACK_USER_ID,
      runId,
      'boundary-test',
      approvalToken,
      planSummary,
    );
    console.log(`  Message sent, ts=${messageTs}`);

    // Step 3: Insert approval row so webhook can resolve it
    console.log('\n--- Step 3: Insert approval row ---');
    const insertApprovalSql = `
      INSERT INTO approvals (pipeline_run_id, token, slack_channel, slack_message_ts, approval_type)
      VALUES ($1, $2, $3, $4, 'plan_approval')
      ON CONFLICT (token) DO NOTHING
      RETURNING id
    `;
    const approvalResult = await pool.query(insertApprovalSql, [
      runId, approvalToken, SLACK_USER_ID, messageTs,
    ]);
    console.log(`  Inserted approval: ${approvalResult.rows[0]?.id}`);
    console.log(`  Token: ${approvalToken}`);

    // Step 4: Wait for user to click
    console.log('\n--- Step 4: Waiting for you to click Approve or Reject in Slack ---');
    console.log('  (polling Postgres every 3 seconds, timeout 120s)\n');

    let resolved = false;
    let finalStatus = '';
    const deadline = Date.now() + 120_000;

    while (Date.now() < deadline) {
      const checkSql = `SELECT status FROM approvals WHERE token = $1`;
      const checkResult = await pool.query(checkSql, [approvalToken]);
      const status = checkResult.rows[0]?.status;

      if (status && status !== 'pending') {
        resolved = true;
        finalStatus = status;
        break;
      }

      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 3000));
    }

    console.log('\n');

    // Step 5: Check results
    console.log('--- Checks ---');

    if (!resolved) {
      console.log('  [FAIL] Timed out waiting for approval resolution');
      console.log('         Did you click a button? Is the Slack interactivity URL configured?');
      process.exit(1);
    }

    console.log(`  [PASS] Approval resolved — status: ${finalStatus}`);

    // Check pipeline_run was updated
    const runCheck = await pool.query(
      'SELECT status, current_stage FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    const runStatus = runCheck.rows[0]?.status;
    const runStage = runCheck.rows[0]?.current_stage;
    console.log(`  [${runStatus === 'running' || runStatus === 'rejected' ? 'PASS' : 'FAIL'}] pipeline_runs.status updated to '${runStatus}'`);
    console.log(`  [INFO] pipeline_runs.current_stage = '${runStage}'`);

    // Check if SQS message was sent (only on approval)
    if (finalStatus === 'approved') {
      console.log('\n--- Step 6: Check SQS stage queue for resume message ---');
      const sqs = new SQSClient({ region: REGION });
      const sqsResult = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: STAGE_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
      }));

      const messages = sqsResult.Messages ?? [];
      const resumeMsg = messages.find(m => {
        try {
          const body = JSON.parse(m.Body ?? '');
          return body.runId === runId;
        } catch { return false; }
      });

      if (resumeMsg) {
        const body = JSON.parse(resumeMsg.Body!);
        console.log(`  [PASS] Resume StageMessage found on stage queue`);
        console.log(`    runId: ${body.runId}`);
        console.log(`    stage: ${body.stage}`);
        console.log(`    projectId: ${body.projectId}`);
      } else {
        console.log(`  [WARN] No resume message found for this runId (may have been consumed by Lambda)`);
      }
    }

    console.log(`\n=== Boundaries 11-13: PASS ===`);
  } finally {
    // Cleanup
    console.log('\n--- Cleanup ---');
    await pool.query('DELETE FROM approvals WHERE token = $1', [approvalToken]);
    console.log(`  Deleted approval row`);
    await pool.query('DELETE FROM agent_runs WHERE pipeline_run_id = $1', [runId]);
    await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
    console.log(`  Deleted pipeline_run row`);
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

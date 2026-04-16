#!/usr/bin/env npx ts-node
/**
 * Pipeline E2E Runner
 *
 * Sends a real PipelineJobMessage to the SQS job queue and monitors
 * the pipeline progressing through stages via Postgres. This is the
 * "fire and watch" script for live validation.
 *
 * What it does:
 *   1. Sends a PipelineJobMessage to the job queue
 *   2. Polls Postgres every 10s for stage progression
 *   3. Reports each stage transition as it happens
 *   4. Exits when pipeline reaches 'completed' or 'failed', or timeout
 *
 * Prerequisites:
 *   1. CDK stack deployed with Phase 2 changes
 *   2. Schema migration applied (init + migrate-002)
 *   3. Lambda has Anthropic API key in Secrets Manager
 *   4. Daytona configured (for agent dispatch stages)
 *   5. Env vars in infra/.env (loaded automatically)
 *
 * Optional overrides (env vars or infra/.env):
 *   REPO_URL         -- Git repo for pipeline to work on (default: this repo)
 *   FEATURE_DESC     -- Feature description (default: test feature)
 *   TIMEOUT_MINUTES  -- Max wait time (default: 30)
 *
 * Usage:
 *   npx ts-node --esm scripts/run-pipeline-e2e.ts
 *   FEATURE_DESC="add a health check endpoint" npx ts-node --esm scripts/run-pipeline-e2e.ts
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load infra/.env (one level up from this script)
config({ path: resolve(import.meta.dirname ?? __dirname, '..', '.env') });

import { createDbPool } from '../../src/cloud/postgres-client.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { PipelineJobMessage } from '../../src/cloud/types.js';
import type { Pool } from 'pg';

// ─── Config ────────────────────────────────────────────────────────────────

const REGION = 'us-east-1';
const POLL_INTERVAL_MS = 10_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// ─── Pipeline monitor ──────────────────────────────────────────────────────

interface PipelineSnapshot {
  status: string;
  currentStage: string;
  agentRuns: Array<{
    taskKey: string;
    planName: string;
    status: string;
    costUsd: number;
    durationMs: number;
  }>;
}

async function getPipelineSnapshot(pool: Pool, runId: string): Promise<PipelineSnapshot | null> {
  const pipelineResult = await pool.query(
    'SELECT status, current_stage FROM pipeline_runs WHERE id = $1',
    [runId],
  );
  if (pipelineResult.rows.length === 0) return null;

  const row = pipelineResult.rows[0];

  const agentResult = await pool.query(
    `SELECT task_key, plan_name, status, cost_usd, duration_ms
     FROM agent_runs WHERE pipeline_run_id = $1
     ORDER BY created_at ASC`,
    [runId],
  );

  return {
    status: row.status,
    currentStage: row.current_stage,
    agentRuns: agentResult.rows.map((r: Record<string, unknown>) => ({
      taskKey: r.task_key as string,
      planName: r.plan_name as string,
      status: r.status as string,
      costUsd: parseFloat(String(r.cost_usd ?? 0)),
      durationMs: parseInt(String(r.duration_ms ?? 0), 10),
    })),
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const sqsQueueUrl = requireEnv('SQS_QUEUE_URL');
  const repoUrl = process.env.REPO_URL ?? 'https://github.com/test/example-repo.git';
  const featureDesc = process.env.FEATURE_DESC ?? 'Add a simple health check endpoint that returns 200 OK';
  const timeoutMinutes = parseInt(process.env.TIMEOUT_MINUTES ?? '30', 10);

  const pool = createDbPool(databaseUrl);
  const sqs = new SQSClient({ region: REGION });
  const timeoutMs = timeoutMinutes * 60 * 1000;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Pipeline E2E Runner                             ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log(`  Repo:     ${repoUrl}`);
  console.log(`  Feature:  ${featureDesc}`);
  console.log(`  Timeout:  ${timeoutMinutes} minutes`);
  console.log(`  Queue:    ${sqsQueueUrl.slice(-40)}...`);
  console.log();

  // Step 1: Send PipelineJobMessage
  const message: PipelineJobMessage = {
    projectId: `e2e-${Date.now()}`,
    repoUrl,
    branch: 'main',
    featureDescription: featureDesc,
  };

  console.log('  Sending PipelineJobMessage to job queue...');
  await sqs.send(new SendMessageCommand({
    QueueUrl: sqsQueueUrl,
    MessageBody: JSON.stringify(message),
  }));
  console.log('  Sent. Waiting for Lambda to create pipeline_run...\n');

  // Step 2: Poll for pipeline_run creation
  let runId: string | null = null;
  const pollStart = Date.now();

  while (!runId && Date.now() - pollStart < 60_000) {
    const result = await pool.query(
      `SELECT id FROM pipeline_runs
       WHERE project_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [message.projectId],
    );
    if (result.rows.length > 0) {
      runId = result.rows[0].id as string;
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!runId) {
    console.error('  TIMEOUT: No pipeline_run created within 60s.');
    console.error('  Check Lambda logs: aws logs tail /aws/lambda/cah-dev-stage-router --follow');
    await pool.end();
    process.exit(1);
  }

  console.log(`  Pipeline run created: ${runId}\n`);
  console.log('───────────────────────────────────────────────────');
  console.log('  Stage progression (polling every 10s)');
  console.log('───────────────────────────────────────────────────\n');

  // Step 3: Monitor stage progression
  let lastStage = '';
  let lastTaskCount = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const snapshot = await getPipelineSnapshot(pool, runId);
    if (!snapshot) {
      console.log('  WARNING: pipeline_run disappeared from Postgres');
      break;
    }

    // Report stage transitions
    if (snapshot.currentStage !== lastStage) {
      const elapsed = formatDuration(Date.now() - startTime);
      console.log(`  [${elapsed}] Stage: ${lastStage || 'start'} -> ${snapshot.currentStage}`);
      lastStage = snapshot.currentStage;
    }

    // Report new agent tasks
    if (snapshot.agentRuns.length > lastTaskCount) {
      for (let i = lastTaskCount; i < snapshot.agentRuns.length; i++) {
        const task = snapshot.agentRuns[i];
        console.log(`           Task: ${task.planName} [${task.status}] ${task.costUsd > 0 ? `$${task.costUsd.toFixed(4)}` : ''} ${task.durationMs > 0 ? formatDuration(task.durationMs) : ''}`);
      }
      lastTaskCount = snapshot.agentRuns.length;
    }

    // Check terminal states
    if (snapshot.status === 'completed') {
      const elapsed = formatDuration(Date.now() - startTime);
      const totalCost = snapshot.agentRuns.reduce((sum, r) => sum + r.costUsd, 0);
      const totalDuration = snapshot.agentRuns.reduce((sum, r) => sum + r.durationMs, 0);

      console.log('\n═══════════════════════════════════════════════════');
      console.log('  PIPELINE COMPLETED');
      console.log('───────────────────────────────────────────────────');
      console.log(`  Run ID:    ${runId}`);
      console.log(`  Wall time: ${elapsed}`);
      console.log(`  CPU time:  ${formatDuration(totalDuration)}`);
      console.log(`  Cost:      $${totalCost.toFixed(4)}`);
      console.log(`  Tasks:     ${snapshot.agentRuns.length}`);
      console.log('═══════════════════════════════════════════════════\n');

      await pool.end();
      return;
    }

    if (snapshot.status === 'failed') {
      const elapsed = formatDuration(Date.now() - startTime);
      const failedTasks = snapshot.agentRuns.filter((r) => r.status === 'failed');

      console.log('\n═══════════════════════════════════════════════════');
      console.log('  PIPELINE FAILED');
      console.log('───────────────────────────────────────────────────');
      console.log(`  Run ID:      ${runId}`);
      console.log(`  Failed at:   ${snapshot.currentStage}`);
      console.log(`  Wall time:   ${elapsed}`);
      console.log(`  Failed tasks: ${failedTasks.length}`);
      console.log();
      console.log('  Check agent_runs for errors:');
      console.log(`    SELECT task_key, error_message FROM agent_runs WHERE pipeline_run_id = '${runId}' AND status = 'failed';`);
      console.log('═══════════════════════════════════════════════════\n');

      await pool.end();
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timeout
  console.log(`\n  TIMEOUT: Pipeline did not complete within ${timeoutMinutes} minutes.`);
  console.log(`  Run ID: ${runId}`);
  console.log(`  Last stage: ${lastStage}`);
  console.log(`  Check Lambda logs and agent_runs table for details.`);

  await pool.end();
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

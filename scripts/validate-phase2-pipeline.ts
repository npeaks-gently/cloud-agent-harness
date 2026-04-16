#!/usr/bin/env npx ts-node
/**
 * Phase 2 Pipeline Validation Script
 *
 * Validates pipeline orchestration and state management against deployed AWS:
 * - PIPE-01: Stage router dispatches to all 7 stages in order
 * - STATE-01: Checkpoint writes persist agent task outcomes to Postgres
 * - STATE-02: Resume skips completed tasks on replay
 * - STATE-03: Idempotent upserts prevent duplicate agent_runs rows
 * - PIPE-04: S3 context sync (covered by validate-phase1 INFRA-03)
 *
 * Prerequisites:
 *   1. CDK stack deployed with Phase 2 changes: cd infra && npx cdk deploy
 *   2. Schema migration applied: psql "$DATABASE_URL" -f scripts/migrate-002-idempotency.sql
 *   3. Environment variables set (see below)
 *
 * Required environment variables:
 *   DATABASE_URL     -- Postgres connection string
 *   SQS_QUEUE_URL    -- SQS job queue URL (from CDK output QueueUrl)
 *   STAGE_QUEUE_URL  -- SQS stage queue URL (from CDK output StageQueueUrl)
 *
 * Usage: npx ts-node --esm scripts/validate-phase2-pipeline.ts
 */

import { createDbPool } from '../src/cloud/postgres-client.js';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { buildTaskId, upsertAgentRun, getCompletedTasks } from '../src/cloud/pipeline/idempotency.js';
import { writeAgentCheckpoint, updatePipelineStage, getPipelineState } from '../src/cloud/pipeline/checkpoint.js';
import { resumePipeline } from '../src/cloud/pipeline/resume.js';
import { PipelineStage, NEXT_STAGE } from '../src/cloud/pipeline/types.js';
import type { AgentRunData, AgentTaskOutcome } from '../src/cloud/pipeline/types.js';
import type { PipelineJobMessage } from '../src/cloud/types.js';
import type { Pool } from 'pg';

// ─── Types ─────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const REGION = 'us-east-1';
const STAGES_IN_ORDER: PipelineStage[] = [
  PipelineStage.Intake,
  PipelineStage.Research,
  PipelineStage.Plan,
  PipelineStage.Approve,
  PipelineStage.Execute,
  PipelineStage.Verify,
  PipelineStage.PR,
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function randomRunId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runTest(
  name: string,
  fn: () => Promise<string>,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const message = await fn();
    return { name, passed: true, message, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, passed: false, message, durationMs: Date.now() - start };
  }
}

// ─── Test: Schema migration applied ────────────────────────────────────────

async function testSchemaMigration(pool: Pool): Promise<string> {
  // Check task_key column exists on agent_runs
  const taskKeyCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'agent_runs' AND column_name = 'task_key'
  `);
  if (taskKeyCheck.rows.length === 0) {
    throw new Error('task_key column missing from agent_runs — run migrate-002-idempotency.sql');
  }

  // Check current_stage column exists on pipeline_runs
  const stageCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'current_stage'
  `);
  if (stageCheck.rows.length === 0) {
    throw new Error('current_stage column missing from pipeline_runs — run migrate-002-idempotency.sql');
  }

  // Check unique index on task_key
  const indexCheck = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'agent_runs' AND indexname = 'idx_agent_runs_task_key'
  `);
  if (indexCheck.rows.length === 0) {
    throw new Error('idx_agent_runs_task_key index missing — run migrate-002-idempotency.sql');
  }

  return 'task_key column, current_stage column, and unique index all present';
}

// ─── Test: Pipeline stage progression ──────────────────────────────────────

async function testStageProgression(pool: Pool): Promise<string> {
  // Create a test pipeline run
  const result = await pool.query(`
    INSERT INTO pipeline_runs (project_id, status, phase_current, phase_total, config, current_stage)
    VALUES ('test-project', 'running', 1, 5, '{}', 'intake')
    RETURNING id
  `);
  const runId = result.rows[0].id as string;

  // Walk through each stage transition
  const visited: string[] = ['intake'];
  let currentStage: PipelineStage | null = PipelineStage.Intake;

  while (currentStage !== null) {
    const next = NEXT_STAGE[currentStage];
    await updatePipelineStage(pool, runId, next);
    if (next !== null) visited.push(next);
    currentStage = next;
  }

  // Verify pipeline is completed
  const state = await getPipelineState(pool, runId);
  if (!state) throw new Error('Pipeline run not found after stage progression');
  if (state.status !== 'completed') throw new Error(`Expected status=completed, got ${state.status}`);
  if (state.currentStage !== 'completed') throw new Error(`Expected currentStage=completed, got ${state.currentStage}`);

  // Cleanup
  await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);

  return `Traversed ${visited.length} stages: ${visited.join(' -> ')} -> completed`;
}

// ─── Test: Checkpoint write + read ─────────────────────────────────────────

async function testCheckpointWriteRead(pool: Pool): Promise<string> {
  // Create pipeline run
  const result = await pool.query(`
    INSERT INTO pipeline_runs (project_id, status, phase_current, phase_total, config, current_stage)
    VALUES ('test-checkpoint', 'running', 1, 3, '{}', 'research')
    RETURNING id
  `);
  const runId = result.rows[0].id as string;

  // Write a checkpoint
  const taskKey = buildTaskId(runId, 'research', 'main', 1);
  const data: AgentRunData = {
    pipelineRunId: runId,
    phase: 1,
    planName: 'main',
    wave: 1,
    status: 'running',
  };
  const outcome: AgentTaskOutcome = {
    taskKey,
    success: true,
    exitCode: 0,
    durationMs: 12500,
    costUsd: 0.042,
    artifacts: ['research-output.md', 'analysis.json'],
  };

  await writeAgentCheckpoint(pool, taskKey, data, outcome);

  // Read back and verify
  const row = await pool.query(
    'SELECT task_key, status, cost_usd, duration_ms, artifacts FROM agent_runs WHERE task_key = $1',
    [taskKey],
  );
  if (row.rows.length === 0) throw new Error('Checkpoint row not written');

  const r = row.rows[0];
  if (r.status !== 'completed') throw new Error(`Expected status=completed, got ${r.status}`);
  if (parseFloat(r.cost_usd) !== 0.042) throw new Error(`Expected cost_usd=0.042, got ${r.cost_usd}`);
  if (r.duration_ms !== 12500) throw new Error(`Expected duration_ms=12500, got ${r.duration_ms}`);

  const artifacts = typeof r.artifacts === 'string' ? JSON.parse(r.artifacts) : r.artifacts;
  if (artifacts.length !== 2) throw new Error(`Expected 2 artifacts, got ${artifacts.length}`);

  // Cleanup
  await pool.query('DELETE FROM agent_runs WHERE pipeline_run_id = $1', [runId]);
  await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);

  return `Checkpoint written and read back: task_key=${taskKey}, cost=$${outcome.costUsd}, duration=${outcome.durationMs}ms, artifacts=${artifacts.length}`;
}

// ─── Test: Idempotent upsert (no duplicates) ───────────────────────────────

async function testIdempotentUpsert(pool: Pool): Promise<string> {
  // Create pipeline run
  const result = await pool.query(`
    INSERT INTO pipeline_runs (project_id, status, phase_current, phase_total, config, current_stage)
    VALUES ('test-idempotent', 'running', 1, 3, '{}', 'execute')
    RETURNING id
  `);
  const runId = result.rows[0].id as string;

  const taskKey = buildTaskId(runId, 'execute', '02-01', 1);
  const data: AgentRunData = {
    pipelineRunId: runId,
    phase: 2,
    planName: '02-01',
    wave: 1,
    status: 'running',
  };

  // Insert first time
  await upsertAgentRun(pool, taskKey, data);

  // Insert second time (simulating replay) — should NOT create duplicate
  await upsertAgentRun(pool, taskKey, { ...data, status: 'completed' });

  // Insert third time — still no duplicate
  await upsertAgentRun(pool, taskKey, { ...data, status: 'completed' });

  // Count rows — must be exactly 1
  const count = await pool.query(
    'SELECT COUNT(*) as cnt FROM agent_runs WHERE task_key = $1',
    [taskKey],
  );
  const cnt = parseInt(count.rows[0].cnt, 10);
  if (cnt !== 1) throw new Error(`Expected exactly 1 row, got ${cnt} — idempotency broken!`);

  // Verify status was updated to completed
  const row = await pool.query(
    'SELECT status FROM agent_runs WHERE task_key = $1',
    [taskKey],
  );
  if (row.rows[0].status !== 'completed') {
    throw new Error(`Expected status=completed after replay, got ${row.rows[0].status}`);
  }

  // Cleanup
  await pool.query('DELETE FROM agent_runs WHERE pipeline_run_id = $1', [runId]);
  await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);

  return `3 upserts with same task_key produced exactly 1 row (status=completed)`;
}

// ─── Test: Resume skips completed tasks ────────────────────────────────────

async function testResumeSkipsCompleted(pool: Pool): Promise<string> {
  // Create pipeline run at "plan" stage
  const result = await pool.query(`
    INSERT INTO pipeline_runs (project_id, status, phase_current, phase_total, config, current_stage)
    VALUES ('test-resume', 'running', 1, 3, '{}', 'plan')
    RETURNING id
  `);
  const runId = result.rows[0].id as string;

  // Simulate: research stage already completed (2 tasks done)
  const task1Key = buildTaskId(runId, 'research', 'main', 1);
  const task2Key = buildTaskId(runId, 'research', 'context', 1);

  for (const taskKey of [task1Key, task2Key]) {
    await upsertAgentRun(pool, taskKey, {
      pipelineRunId: runId,
      phase: 1,
      planName: taskKey.includes('main') ? 'main' : 'context',
      wave: 1,
      status: 'completed',
    });
  }

  // Resume — should return plan stage + 2 completed tasks
  const resume = await resumePipeline(pool, runId);

  if (resume.stage !== PipelineStage.Plan) {
    throw new Error(`Expected resume stage=plan, got ${resume.stage}`);
  }
  if (resume.completedTasks.length !== 2) {
    throw new Error(`Expected 2 completed tasks, got ${resume.completedTasks.length}`);
  }
  if (!resume.completedTasks.includes(task1Key)) {
    throw new Error(`Missing task1Key in completedTasks`);
  }
  if (!resume.completedTasks.includes(task2Key)) {
    throw new Error(`Missing task2Key in completedTasks`);
  }

  // Cleanup
  await pool.query('DELETE FROM agent_runs WHERE pipeline_run_id = $1', [runId]);
  await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);

  return `Resumed at stage=${resume.stage}, skipping ${resume.completedTasks.length} completed tasks`;
}

// ─── Test: SQS job queue message round-trip ────────────────────────────────

async function testSqsJobMessage(queueUrl: string): Promise<string> {
  const sqs = new SQSClient({ region: REGION });

  const testMessage: PipelineJobMessage = {
    projectId: 'test-validation',
    repoUrl: 'https://github.com/test/repo.git',
    branch: 'main',
    featureDescription: 'Phase 2 validation — this message tests SQS round-trip',
  };

  // Send
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(testMessage),
  }));

  // Receive (with short poll)
  const response = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
  }));

  if (!response.Messages || response.Messages.length === 0) {
    throw new Error('No message received from job queue after 5s');
  }

  const received = JSON.parse(response.Messages[0].Body!) as PipelineJobMessage;
  if (received.projectId !== testMessage.projectId) {
    throw new Error(`projectId mismatch: sent ${testMessage.projectId}, got ${received.projectId}`);
  }

  // Delete the test message so it doesn't trigger the Lambda
  await sqs.send(new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: response.Messages[0].ReceiptHandle!,
  }));

  return `Sent and received PipelineJobMessage on job queue (cleaned up)`;
}

// ─── Test: Full pipeline simulation ────────────────────────────────────────

async function testFullPipelineSimulation(pool: Pool): Promise<string> {
  // Simulates a complete pipeline run through all 7 stages
  // without actually dispatching to Daytona — validates the
  // orchestration logic end-to-end against live Postgres

  const result = await pool.query(`
    INSERT INTO pipeline_runs (project_id, status, phase_current, phase_total, config, current_stage, repo_url, branch, feature_description)
    VALUES ('test-full-pipeline', 'running', 1, 5, '{}', 'intake', 'https://github.com/test/repo.git', 'main', 'E2E pipeline simulation')
    RETURNING id
  `);
  const runId = result.rows[0].id as string;

  const log: string[] = [];

  for (const stage of STAGES_IN_ORDER) {
    // Simulate agent task for each stage
    const taskKey = buildTaskId(runId, stage, 'main', 1);
    const data: AgentRunData = {
      pipelineRunId: runId,
      phase: 1,
      planName: stage,
      wave: 1,
      status: 'running',
    };
    const outcome: AgentTaskOutcome = {
      taskKey,
      success: true,
      exitCode: 0,
      durationMs: Math.floor(Math.random() * 30000) + 1000,
      costUsd: parseFloat((Math.random() * 0.1).toFixed(4)),
      artifacts: [`${stage}-output.md`],
    };

    await writeAgentCheckpoint(pool, taskKey, data, outcome);

    // Advance pipeline to next stage
    const nextStage = NEXT_STAGE[stage];
    await updatePipelineStage(pool, runId, nextStage);

    log.push(`${stage}(${outcome.durationMs}ms/$${outcome.costUsd})`);
  }

  // Verify final state
  const finalState = await getPipelineState(pool, runId);
  if (!finalState) throw new Error('Pipeline run not found after full simulation');
  if (finalState.status !== 'completed') throw new Error(`Expected completed, got ${finalState.status}`);
  if (finalState.completedTasks.length !== 7) {
    throw new Error(`Expected 7 completed tasks, got ${finalState.completedTasks.length}`);
  }

  // Verify resume would return no pending work
  const resume = await resumePipeline(pool, runId);
  if (resume.completedTasks.length !== 7) {
    throw new Error(`Resume should show 7 completed tasks, got ${resume.completedTasks.length}`);
  }

  // Cleanup
  await pool.query('DELETE FROM agent_runs WHERE pipeline_run_id = $1', [runId]);
  await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);

  return `Full pipeline: ${log.join(' -> ')} -> completed (7/7 checkpoints, resume clean)`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Phase 2: Pipeline Orchestration Validation      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const databaseUrl = requireEnv('DATABASE_URL');
  const sqsQueueUrl = process.env.SQS_QUEUE_URL; // Optional — skip SQS test if not set

  const pool = createDbPool(databaseUrl);

  const results: TestResult[] = [];

  // Core tests (require only DATABASE_URL)
  results.push(await runTest('Schema migration applied', () => testSchemaMigration(pool)));
  results.push(await runTest('Pipeline stage progression (7 stages)', () => testStageProgression(pool)));
  results.push(await runTest('Checkpoint write + read', () => testCheckpointWriteRead(pool)));
  results.push(await runTest('Idempotent upsert (no duplicates)', () => testIdempotentUpsert(pool)));
  results.push(await runTest('Resume skips completed tasks', () => testResumeSkipsCompleted(pool)));
  results.push(await runTest('Full pipeline simulation (E2E)', () => testFullPipelineSimulation(pool)));

  // SQS test (optional)
  if (sqsQueueUrl) {
    results.push(await runTest('SQS job queue round-trip', () => testSqsJobMessage(sqsQueueUrl)));
  } else {
    console.log('  SKIP  SQS job queue round-trip (SQS_QUEUE_URL not set)\n');
  }

  // ─── Report ────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Results');
  console.log('───────────────────────────────────────────────────\n');

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    const time = `${r.durationMs}ms`;
    console.log(`  ${icon}  ${r.name} (${time})`);
    if (r.passed) {
      console.log(`       ${r.message}`);
    } else {
      console.log(`       ERROR: ${r.message}`);
    }
    console.log();
    if (r.passed) passed++;
    else failed++;
  }

  console.log('───────────────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);
  console.log('═══════════════════════════════════════════════════\n');

  await pool.end();

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

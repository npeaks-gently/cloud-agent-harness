# Phase 2: Pipeline Orchestration & State Management - Research

**Researched:** 2026-04-16
**Domain:** Pipeline orchestration, checkpoint/resume, Daytona sandbox lifecycle, S3 artifact storage, Postgres state management
**Confidence:** HIGH

## Summary

Phase 2 builds the pipeline orchestrator that drives the full agent lifecycle (research, plan, approve, execute, verify, PR) using Lambda functions connected by SQS messages. Each pipeline stage runs in its own Lambda invocation, dispatching agent work to Daytona sandboxes via the Phase 1 service clients. Agents pull context from S3 at startup and push artifacts back on completion. Every agent task checkpoints to Postgres, enabling resume-from-failure by skipping completed tasks on replay.

The architecture is deliberately simple: no Step Functions (D-04), no parallel agent execution (deferred to v2). The orchestrator is a set of Lambda handlers that process SQS messages, call the Daytona SDK to spawn sandboxes, and write checkpoint state to Postgres. The Daytona SDK's `Image.base()` builder and snapshot service eliminate the need for a separate Docker registry -- the harness runtime image can be defined declaratively in code and registered as a Daytona snapshot.

**Primary recommendation:** Build a Lambda-per-stage pipeline with SQS bridges, a declarative Daytona snapshot defined via `Image.base()`, and an entrypoint script that transforms sandbox boot into agent execution. Use deterministic task IDs (`{runId}:{phase}:{plan}:{wave}`) for idempotency across all external writes.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Simple Node.js orchestrator -- no Step Functions for v1. Sequential stage execution via direct function calls to the Phase 1 service clients (DaytonaClient, S3, Postgres, SQS).
- **D-02:** Lambda per pipeline stage with SQS messages between stages. Each stage Lambda stays under 15 minutes. SQS message between stages is a natural checkpoint boundary. Serverless = no idle cost.
- **D-03:** Pipeline triggered by SQS job message (PipelineJobMessage from Phase 1). The existing SqsConsumer receives the message, the orchestrator Lambda processes it through stages.
- **D-04:** No Step Functions for v1. Can be added later if visual debugging and built-in retry become worth the integration complexity with Daytona.
- **D-05:** Build a Docker image with the harness runtime baked in: Node.js 22, @anthropic-ai/claude-agent-sdk, GSD harness tools, agent definitions, and an entrypoint script.
- **D-06:** Push image to a container registry (ECR or Docker Hub). Daytona uses this as a sandbox snapshot -- every sandbox starts with the harness pre-installed.
- **D-07:** Entrypoint script in the image: (1) clones the target repo, (2) reads task config from environment variables or S3, (3) runs the agent session via the SDK, (4) pushes artifacts to S3, (5) reports status back to the orchestrator.
- **D-08:** Image built locally and pushed to registry. Rebuild and push when the harness changes. No CI/CD for image builds in v1.
- **D-09:** Full lifecycle for v1: research -> plan -> approve -> execute -> verify -> PR.
- **D-10:** Approve stage is auto-approve until Phase 3 (Slack integration). Orchestrator logs the auto-approval and continues.
- **D-11:** Each stage maps to one or more Daytona sandbox tasks. Research may spawn multiple parallel researchers. Execute spawns agents per plan/wave. Other stages are single-agent.
- **D-12:** Per agent task checkpoint granularity. Every completed agent task writes a checkpoint to the agent_runs table in Postgres.
- **D-13:** On pipeline failure, resume reads agent_runs for the pipeline_run_id, identifies which tasks completed successfully, and skips them.
- **D-14:** Pipeline-level state stored in pipeline_runs table (current stage, current phase, status). Updated by the orchestrator after each stage completes.
- **D-15:** Idempotency: each agent task has a deterministic ID derived from run_id + phase + plan + wave. Re-running a task with the same ID is safe.
- **D-16:** Full .planning/ directory downloaded from S3 into each sandbox at task start. Agents see the same file structure they'd see locally.
- **D-17:** Scoped upload after task completion -- agents only push files they created or modified.
- **D-18:** Shared files (STATE.md, ROADMAP.md) are written only by the orchestrator, never by agents.
- **D-19:** S3 key structure follows Phase 1 convention: runs/{run_id}/phases/{phase}/{file}.

### Claude's Discretion
- Lambda function structure (handler signatures, module organization)
- SQS message format between stages (beyond the existing PipelineJobMessage)
- Entrypoint script implementation details
- Dockerfile specifics (base image, layer ordering, optimization)
- Error classification and retry strategy for transient vs permanent failures
- Postgres query patterns for checkpoint reads/writes beyond existing client functions

### Deferred Ideas (OUT OF SCOPE)
- Step Functions orchestration -- revisit if visual debugging or built-in retry becomes worth the Daytona integration complexity
- ECS Fargate -- may be needed in Phase 5 for the always-on API service, not needed for orchestration
- Parallel agent execution in cloud -- deferred to v2 (EXEC-02), sequential within waves for now
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PIPE-01 | Step Functions state machine for end-to-end pipeline | Per D-01/D-04, replaced by Lambda+SQS pipeline. Research provides Lambda handler patterns, SQS inter-stage messaging, and stage-to-Lambda mapping. |
| PIPE-04 | Codebase context provisioning via S3 | Research provides S3 sync patterns for .planning/ directory download/upload, artifact key structure, and scoped upload strategy. |
| STATE-01 | Postgres-backed checkpoint at wave and phase boundaries | Research provides checkpoint schema extensions, query patterns for getCompletedTasks(), and pipeline_runs stage tracking. |
| STATE-02 | Resume from last good checkpoint on any transient failure | Research provides resume algorithm, error classification (transient vs permanent), and skip-completed-tasks pattern. |
| STATE-03 | Idempotency keys on all external writes | Research provides deterministic task ID format (`{runId}:{phase}:{plan}:{wave}`), Postgres UPSERT pattern, and S3 overwrite safety. |
| STATE-04 | Storage abstraction where agents pull from S3 and push back | Research provides entrypoint script design, S3 context sync, .planning/ download/upload patterns, and Daytona Image builder for pre-installed harness. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Pipeline stage sequencing | Lambda + SQS (Orchestration) | -- | Each Lambda handles one stage, SQS messages bridge between stages |
| Agent task execution | Daytona Sandbox (Execution) | Lambda (dispatch) | Sandboxes run agents; Lambda dispatches and monitors |
| Checkpoint persistence | Postgres (Storage) | -- | agent_runs and pipeline_runs tables are the checkpoint store |
| Artifact storage | S3 (Storage) | -- | .planning/ files, code artifacts, agent outputs |
| Context provisioning | S3 (Storage) | Daytona Sandbox (consumer) | S3 is source of truth; sandbox downloads at start, uploads at end |
| Idempotency enforcement | Postgres (Storage) | S3 (overwrite) | Deterministic task IDs resolve to same Postgres row and S3 keys |
| Image/snapshot management | Daytona API (Execution) | -- | Snapshot created via Daytona SDK Image builder, no separate registry needed |
| Error classification | Lambda (Orchestration) | -- | Orchestrator decides retry vs fail vs skip |
| Pipeline resume | Lambda (Orchestration) | Postgres (query) | Lambda queries Postgres for completed tasks, skips them |

## Standard Stack

### Core (Already Installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @daytonaio/sdk | 0.166.0 | Sandbox lifecycle, Image builder, Snapshot service | [VERIFIED: npm registry, node_modules] Already in package.json; provides `Image.base()` for declarative snapshot creation |
| @aws-sdk/client-s3 | 3.1030.0 | S3 artifact upload/download | [VERIFIED: package.json] Phase 1 dependency, used by s3-artifacts.ts |
| @aws-sdk/client-sqs | 3.1030.0 | SQS message send/receive | [VERIFIED: package.json] Phase 1 dependency, used by sqs-consumer.ts |
| pg | 8.20.0 | Postgres connection pool + queries | [VERIFIED: package.json] Phase 1 dependency, used by postgres-client.ts |
| @anthropic-ai/claude-agent-sdk | 0.2.110 | Agent execution via query() | [VERIFIED: npm registry] SDK backbone for agent sessions |

### New Dependencies Needed
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @aws-sdk/client-lambda | 3.1030.0 | Lambda invocation (if needed for stage dispatch) | Only if Lambda-to-Lambda invocation is chosen over SQS-to-Lambda |
| aws-cdk-lib | (existing in infra/) | CDK constructs for Lambda functions + IAM | Already in infra/package.json for CDK stack |

### No Additional Dependencies
The phase builds on Phase 1's existing dependencies. Key utilities available from Node.js 22 built-ins:
- `crypto.randomUUID()` for ID generation -- no need for `uuid` package [VERIFIED: Node.js 22 runtime test]
- `node:fs/promises` for file operations
- `node:child_process` for shell invocation in entrypoint script

**Installation:**
```bash
# No new npm packages needed for the application code.
# CDK Lambda constructs are already available via aws-cdk-lib in infra/.
# AWS SDK Lambda client only if Lambda-to-Lambda invocation is chosen.
```

## Architecture Patterns

### System Architecture Diagram

```
                        Pipeline Trigger
                             |
                    [SQS Job Queue]
                             |
                    +--------v--------+
                    | Intake Lambda   |  <-- receives PipelineJobMessage
                    | (stage: intake) |      creates pipeline_run in Postgres
                    +--------+--------+      sends SQS message to stage queue
                             |
                    [SQS Stage Queue]
                             |
              +--------------v--------------+
              |      Stage Router Lambda    |  <-- reads stage from SQS message
              |  routes to stage handler fn |      dispatches to correct handler
              +-+---+---+---+---+---+---+--+
                |   |   |   |   |   |   |
                v   v   v   v   v   v   v
           research plan approve execute verify PR
                |   |   |   |   |   |   |
                v   v   v   v   v   v   v
          +-----+---+---+---+---+---+---+------+
          |     Daytona Sandbox(es)              |
          |  1. Pull .planning/ from S3          |
          |  2. Clone target repo via git        |
          |  3. Run agent via claude-agent-sdk   |
          |  4. Push artifacts to S3             |
          |  5. Report result to orchestrator    |
          +-----+---+---+---+---+---+---+------+
                |   |   |   |   |   |   |
                v   v   v   v   v   v   v
          [Postgres: agent_runs checkpoint]
          [Postgres: pipeline_runs status]
                             |
                    [SQS Stage Queue]  <-- next stage message
                             |
                      (loop continues)
```

**Data flow for a single agent task:**
1. Stage Lambda receives SQS message with `{runId, stage, taskConfig}`
2. Lambda queries Postgres: "Is this task already completed?" (idempotency check)
3. If not completed: Lambda calls `DaytonaClient.executeTask()` with Image-based sandbox
4. Sandbox entrypoint: downloads .planning/ from S3, clones repo, runs agent, uploads artifacts
5. Lambda records result in `agent_runs` table
6. Lambda sends SQS message for next stage (or marks pipeline complete)

### Recommended Project Structure
```
src/cloud/
  pipeline/
    types.ts              # PipelineStage enum, StageMessage, StageResult types
    stage-router.ts       # Routes SQS message to correct stage handler
    stages/
      intake.ts           # Creates pipeline_run, dispatches first stage
      research.ts         # Spawns research agent(s) in Daytona
      plan.ts             # Spawns planning agent in Daytona
      approve.ts          # Auto-approve (placeholder for Phase 3 Slack)
      execute.ts          # Spawns executor agents per plan/wave
      verify.ts           # Spawns verifier agent in Daytona
      pr.ts               # Creates PR from accumulated artifacts
    checkpoint.ts         # Postgres checkpoint read/write helpers
    idempotency.ts        # Deterministic task ID generation + check
    resume.ts             # Resume-from-failure logic
    sandbox-task.ts       # Wraps DaytonaClient for pipeline context
  snapshot/
    image-builder.ts      # Daytona Image definition for harness runtime
    snapshot-manager.ts   # Create/verify Daytona snapshot
  entrypoint/
    agent-entrypoint.ts   # Script baked into sandbox image
    s3-sync.ts            # Download .planning/ from S3, upload artifacts back
infra/lib/constructs/
  pipeline-lambda.ts      # CDK construct for Lambda functions + SQS subscriptions
```

### Pattern 1: Lambda Stage Handler
**What:** Each pipeline stage is a pure async function that receives a stage message, dispatches work to Daytona, and returns a stage result.
**When to use:** Every pipeline stage follows this pattern.
**Example:**
```typescript
// Source: Architecture pattern derived from D-02, D-09
import type { Pool } from 'pg';
import type { StageMessage, StageResult } from '../types.js';
import { getCompletedTasks } from '../checkpoint.js';
import { runAgentTask } from '../sandbox-task.js';

export async function handleResearchStage(
  msg: StageMessage,
  pool: Pool,
): Promise<StageResult> {
  // Check for previously completed tasks (resume support)
  const completed = await getCompletedTasks(pool, msg.runId, 'research');

  // Skip if already done
  if (completed.includes('research-main')) {
    return { stage: 'research', status: 'skipped', tasks: [] };
  }

  // Dispatch to Daytona sandbox
  const result = await runAgentTask({
    runId: msg.runId,
    stage: 'research',
    taskId: `${msg.runId}:research:main:1`,
    repoUrl: msg.repoUrl,
    branch: msg.branch,
    command: 'node /harness/entrypoint.js --stage research',
  }, pool);

  return {
    stage: 'research',
    status: result.success ? 'completed' : 'failed',
    tasks: [result],
  };
}
```

### Pattern 2: Deterministic Task ID for Idempotency
**What:** Every agent task has an ID computed from `{runId}:{phase}:{plan}:{wave}` that serves as both the Postgres primary key and the S3 artifact prefix.
**When to use:** All external writes (Postgres inserts, S3 uploads, future git commits).
**Example:**
```typescript
// Source: Derived from D-15
export function buildTaskId(
  runId: string,
  phase: string,
  plan: string,
  wave: number,
): string {
  return `${runId}:${phase}:${plan}:${wave}`;
}

// Used for idempotent Postgres upsert
export async function upsertAgentRun(
  pool: Pool,
  taskId: string,
  data: AgentRunData,
): Promise<void> {
  const sql = `
    INSERT INTO agent_runs (id, pipeline_run_id, phase, plan_name, wave, status, started_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      started_at = CASE
        WHEN agent_runs.status IN ('completed', 'failed') THEN agent_runs.started_at
        ELSE EXCLUDED.started_at
      END
  `;
  await pool.query(sql, [taskId, data.runId, data.phase, data.plan, data.wave, 'running']);
}
```

### Pattern 3: Daytona Image Builder for Harness Snapshot
**What:** Use the Daytona SDK's `Image.base()` to declaratively define a snapshot with Node.js 22, the harness runtime, and the entrypoint script -- no separate Docker registry needed.
**When to use:** Snapshot creation/update when the harness code changes.
**Example:**
```typescript
// Source: [VERIFIED: @daytonaio/sdk 0.166.0 Image.d.ts, Snapshot.d.ts]
import { Image, Daytona } from '@daytonaio/sdk';

export function buildHarnessImage(): Image {
  return Image.base('node:22-slim')
    .runCommands(
      'apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*',
    )
    .workdir('/harness')
    .addLocalDir('./sdk', '/harness/sdk')
    .addLocalDir('./agents', '/harness/agents')
    .addLocalDir('./commands', '/harness/commands')
    .addLocalDir('./get-shit-done', '/harness/get-shit-done')
    .addLocalFile('./package.json', '/harness/package.json')
    .addLocalFile('./package-lock.json', '/harness/package-lock.json')
    .runCommands('cd /harness && npm ci --production')
    .addLocalFile('./src/cloud/entrypoint/agent-entrypoint.js', '/harness/entrypoint.js')
    .env({ NODE_ENV: 'production' });
}

export async function createOrUpdateSnapshot(daytona: Daytona): Promise<void> {
  const image = buildHarnessImage();
  await daytona.snapshot.create(
    { name: 'cah-harness-v1', image },
    { onLogs: console.log, timeout: 300 },
  );
}
```

### Pattern 4: S3 Context Sync in Entrypoint
**What:** The entrypoint script running inside a Daytona sandbox downloads the .planning/ directory from S3, runs the agent, then uploads modified files back.
**When to use:** Every agent task execution.
**Example:**
```typescript
// Source: Derived from D-16, D-17, D-19
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

export async function downloadPlanningDir(
  s3: S3Client,
  bucket: string,
  runId: string,
  targetDir: string,
): Promise<void> {
  const prefix = `runs/${runId}/planning/`;
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));

  for (const obj of objects.Contents ?? []) {
    const key = obj.Key!;
    const relativePath = key.slice(prefix.length);
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const content = await response.Body!.transformToByteArray();
    // Write to targetDir/.planning/{relativePath}
    await writeFileRecursive(`${targetDir}/.planning/${relativePath}`, Buffer.from(content));
  }
}

export async function uploadModifiedFiles(
  s3: S3Client,
  bucket: string,
  runId: string,
  phase: string,
  files: Array<{ path: string; content: Buffer }>,
): Promise<string[]> {
  const uploadedKeys: string[] = [];
  for (const file of files) {
    const key = `runs/${runId}/phases/${phase}/${file.path}`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.content,
      ChecksumAlgorithm: 'SHA256',
    }));
    uploadedKeys.push(key);
  }
  return uploadedKeys;
}
```

### Pattern 5: SQS Inter-Stage Message
**What:** After each stage completes, the Lambda sends an SQS message containing the run ID and next stage to the stage queue. This is the natural checkpoint boundary.
**When to use:** Between every pipeline stage.
**Example:**
```typescript
// Source: Derived from D-02, D-03
export interface StageMessage {
  runId: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  stage: PipelineStage;
  /** Accumulated context from previous stages */
  context: {
    featureDescription: string;
    phaseNumber: number;
    phaseTotal: number;
    /** S3 keys for artifacts from previous stages */
    previousArtifacts: string[];
  };
}

export enum PipelineStage {
  Intake = 'intake',
  Research = 'research',
  Plan = 'plan',
  Approve = 'approve',
  Execute = 'execute',
  Verify = 'verify',
  PR = 'pr',
}

// Stage transition map
const NEXT_STAGE: Record<PipelineStage, PipelineStage | null> = {
  [PipelineStage.Intake]: PipelineStage.Research,
  [PipelineStage.Research]: PipelineStage.Plan,
  [PipelineStage.Plan]: PipelineStage.Approve,
  [PipelineStage.Approve]: PipelineStage.Execute,
  [PipelineStage.Execute]: PipelineStage.Verify,
  [PipelineStage.Verify]: PipelineStage.PR,
  [PipelineStage.PR]: null, // terminal
};
```

### Anti-Patterns to Avoid
- **Shared mutable state between agents:** Agents must never write to STATE.md or ROADMAP.md. Only the orchestrator Lambda writes shared state files. Agents write only their own scoped artifacts. [VERIFIED: D-18 from CONTEXT.md]
- **Lambda-to-Lambda direct invocation:** Prefer SQS between stages for durability and natural checkpoint boundaries. Direct Lambda invocation loses the message if either Lambda crashes. [ASSUMED -- standard serverless pattern]
- **Fat SQS messages:** SQS messages have a 256KB limit. Never embed artifact content in the message body. Pass S3 keys as references. [VERIFIED: AWS SQS documentation]
- **Polling Daytona for sandbox status:** The Daytona SDK's `executeTask` / `process.executeCommand` blocks until completion. No need for a polling loop. [VERIFIED: daytona-client.ts existing code]
- **Using gen_random_uuid() for task IDs:** The existing schema uses random UUIDs. For idempotency, task IDs must be deterministic. Either switch to deterministic IDs or add a separate `task_key` column with a unique constraint. [VERIFIED: D-15, init-db-schema.sql]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sandbox image management | Custom Docker build + ECR push pipeline | Daytona `Image.base()` + `snapshot.create()` | [VERIFIED: @daytonaio/sdk Image.d.ts, Snapshot.d.ts] SDK handles image building, snapshot registration, and lifecycle. No need for ECR, Docker CLI, or separate CI. |
| Idempotent Postgres writes | Manual "check then insert" with race conditions | `INSERT ... ON CONFLICT DO UPDATE` (UPSERT) | [VERIFIED: PostgreSQL standard] Atomic, no race conditions, single round-trip |
| S3 directory sync | Custom recursive download logic | ListObjectsV2 + GetObject in a loop | [VERIFIED: s3-artifacts.ts pattern] The existing pattern works; extend `listArtifacts()` for the planning prefix |
| UUID generation | uuid npm package | `crypto.randomUUID()` | [VERIFIED: Node.js 22 runtime] Built into Node.js 22, no external dependency |
| Lambda event parsing | Manual JSON.parse + field validation | Type guards (existing pattern from sqs-consumer.ts) | [VERIFIED: sqs-consumer.ts] The `isPipelineJobMessage()` pattern is already established |
| Retry with backoff | Custom retry loop | SQS visibility timeout + DLQ redrive | [VERIFIED: messaging.ts CDK construct] SQS already has DLQ configured. Failed messages retry automatically. |

**Key insight:** The Daytona SDK's `Image` builder and `SnapshotService` are the most significant "don't hand-roll" item. D-05/D-06 describe building a Docker image and pushing to ECR, but the SDK provides a programmatic image builder that registers directly as a Daytona snapshot -- eliminating the entire Docker CLI + ECR pipeline. This aligns with D-06's intent ("Daytona uses this as a sandbox snapshot") while being simpler than maintaining a Dockerfile + registry.

## Common Pitfalls

### Pitfall 1: Agent_runs UUID vs Deterministic Task ID
**What goes wrong:** The existing `agent_runs` table uses `gen_random_uuid()` as the primary key. D-15 requires deterministic task IDs for idempotency. If you insert with random UUIDs, replaying a checkpoint creates duplicate rows instead of updating existing ones.
**Why it happens:** Phase 1 schema was designed for recording, not idempotent replay.
**How to avoid:** Add a `task_key TEXT UNIQUE` column to `agent_runs` (derived from `{runId}:{phase}:{plan}:{wave}`). Use `INSERT ... ON CONFLICT (task_key) DO UPDATE` for all agent run writes. Keep the UUID `id` as primary key for foreign key compatibility.
**Warning signs:** Duplicate agent_runs rows for the same logical task after a pipeline replay.

### Pitfall 2: Lambda 15-Minute Timeout vs Agent Execution Time
**What goes wrong:** Lambda has a hard 15-minute timeout. Agent tasks (especially planning and execution) can run longer than 15 minutes in a Daytona sandbox.
**Why it happens:** The Lambda dispatches work to Daytona and waits for completion. If Daytona takes longer than 15 minutes, the Lambda times out.
**How to avoid:** The Lambda should dispatch the sandbox task and return. Use a callback pattern: (1) Lambda sends execute command to Daytona, (2) Lambda exits after recording "running" status, (3) A separate polling mechanism or callback updates the status when complete. Alternatively, increase `DaytonaClient.executeTask()` timeout but ensure the Lambda timeout exceeds it.
**Warning signs:** Lambda timeout errors in CloudWatch; agent tasks that appear to fail but actually completed in Daytona.

### Pitfall 3: SQS Message Visibility Timeout Too Short
**What goes wrong:** If a stage Lambda takes longer than the SQS visibility timeout, SQS re-delivers the message to another Lambda, causing duplicate execution.
**Why it happens:** Default SQS visibility timeout is often 30 seconds. Stage processing (including Daytona sandbox provisioning) takes minutes.
**How to avoid:** Set SQS visibility timeout to at least 6x the expected Lambda execution time (the AWS recommended practice). For a 15-minute Lambda, set visibility timeout to 900 seconds. [CITED: AWS SQS best practices]
**Warning signs:** Duplicate pipeline stage executions; multiple sandboxes created for the same task.

### Pitfall 4: .planning/ Download Race with Large Directories
**What goes wrong:** Downloading the full .planning/ directory from S3 into a sandbox takes time. If the download is incomplete when the agent starts, it reads partial state.
**Why it happens:** The entrypoint script downloads files sequentially; the agent may start before all files are written.
**How to avoid:** The entrypoint script must complete the full S3 download before starting the agent process. This is a sequential dependency, not a race condition -- as long as the entrypoint awaits the download before spawning the agent.
**Warning signs:** Agent errors about missing files that should exist in .planning/.

### Pitfall 5: Daytona Snapshot Staleness
**What goes wrong:** The Daytona snapshot was created with an old version of the harness. Agents fail because SDK APIs changed or agent definitions are outdated.
**Why it happens:** Per D-08, snapshot is rebuilt manually when the harness changes. Easy to forget.
**How to avoid:** Include a version marker in the snapshot (e.g., git SHA or package.json version). The orchestrator Lambda checks the version before dispatching and logs a warning if stale.
**Warning signs:** Agent failures with import errors or missing function errors.

### Pitfall 6: Postgres Connection Pool Exhaustion in Lambda
**What goes wrong:** Each Lambda invocation creates a new connection pool. Under load, this exhausts RDS connection limits.
**Why it happens:** Lambda cold starts create new pools. With SQS-triggered concurrency, many Lambdas can run simultaneously.
**How to avoid:** Use `pool.max = 1` for Lambda (one connection per invocation). Consider RDS Proxy if connection limits become an issue. Alternatively, keep the pool in module-level scope so warm Lambda invocations reuse it. [CITED: AWS Lambda + RDS best practices]
**Warning signs:** "too many clients" errors from Postgres; intermittent connection timeouts.

## Code Examples

### Checkpoint Query: Get Completed Tasks for Resume
```typescript
// Source: Derived from D-13, postgres-client.ts patterns
export async function getCompletedTasks(
  pool: Pool,
  pipelineRunId: string,
  stage?: string,
): Promise<string[]> {
  const sql = stage
    ? `SELECT task_key FROM agent_runs WHERE pipeline_run_id = $1 AND status = 'completed' AND plan_name LIKE $2`
    : `SELECT task_key FROM agent_runs WHERE pipeline_run_id = $1 AND status = 'completed'`;

  const params = stage ? [pipelineRunId, `${stage}%`] : [pipelineRunId];
  const result = await pool.query(sql, params);
  return result.rows.map((r: { task_key: string }) => r.task_key);
}
```

### Pipeline Resume Algorithm
```typescript
// Source: Derived from D-13, D-14
export async function resumePipeline(
  pool: Pool,
  runId: string,
): Promise<{ stage: PipelineStage; completedTasks: string[] }> {
  // Read current pipeline state
  const run = await getPipelineRun(pool, runId);
  if (!run) throw new Error(`Pipeline run ${runId} not found`);

  // Determine which stage to resume from
  // pipeline_runs.config stores the last completed stage
  const lastStage = (run.config as { lastCompletedStage?: string }).lastCompletedStage;
  const resumeStage = lastStage
    ? NEXT_STAGE[lastStage as PipelineStage] ?? PipelineStage.Intake
    : PipelineStage.Intake;

  // Get all completed tasks to skip
  const completedTasks = await getCompletedTasks(pool, runId);

  return { stage: resumeStage, completedTasks };
}
```

### Entrypoint Script (Sandbox)
```typescript
// Source: Derived from D-07, D-16, D-17
#!/usr/bin/env node

import { S3Client } from '@aws-sdk/client-s3';
import { GSD } from '/harness/sdk/src/index.js';

async function main(): Promise<void> {
  // Task config from environment variables
  const runId = process.env.CAH_RUN_ID!;
  const stage = process.env.CAH_STAGE!;
  const phase = process.env.CAH_PHASE!;
  const plan = process.env.CAH_PLAN ?? '';
  const bucket = process.env.CAH_BUCKET!;
  const repoUrl = process.env.CAH_REPO_URL!;
  const branch = process.env.CAH_BRANCH!;

  const s3 = new S3Client({ region: 'us-east-1' });
  const workDir = '/home/daytona/workspace';

  // Step 1: Clone the target repository (handled by Daytona git.clone)
  // Step 2: Download .planning/ from S3
  await downloadPlanningDir(s3, bucket, runId, workDir);

  // Step 3: Run the agent session via SDK
  const gsd = new GSD({ projectDir: workDir, autoMode: true });
  let result;

  switch (stage) {
    case 'research':
      result = await gsd.runPhase(phase, { maxBudgetPerStep: 3.0 });
      break;
    case 'execute':
      result = await gsd.executePlan(plan);
      break;
    // ... other stages
  }

  // Step 4: Upload modified artifacts to S3
  const modifiedFiles = await findModifiedFiles(workDir);
  await uploadModifiedFiles(s3, bucket, runId, phase, modifiedFiles);

  // Step 5: Write result summary to stdout (Lambda reads this)
  console.log(JSON.stringify({
    success: result.success,
    costUsd: result.totalCostUsd,
    durationMs: result.totalDurationMs,
    artifacts: modifiedFiles.map(f => f.path),
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Schema Migration for Idempotent Task Keys
```sql
-- Source: Derived from D-15, Pitfall 1
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS task_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_task_key ON agent_runs(task_key) WHERE task_key IS NOT NULL;

-- Add stage tracking to pipeline_runs
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS current_stage TEXT DEFAULT 'intake';
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS repo_url TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS branch TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS feature_description TEXT;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ECR + Dockerfile for sandbox images | Daytona `Image.base()` + `snapshot.create()` | @daytonaio/sdk 0.150+ | Eliminates Docker CLI dependency, ECR setup, and push scripts [VERIFIED: SDK type definitions] |
| `CreateSandboxFromSnapshotParams` with `language` field | `CreateSandboxFromImageParams` with `Image` object | @daytonaio/sdk 0.150+ | Declarative image builder replaces pre-existing snapshots [VERIFIED: Daytona.d.ts] |
| Step Functions for orchestration | Lambda + SQS pipeline | D-01, D-04 decision | Simpler, fewer AWS services, natural checkpoint at SQS boundaries |
| Random UUID agent_runs IDs | Deterministic task_key for idempotency | Phase 2 schema migration | Enables idempotent replay without duplicate rows |

**Deprecated/outdated:**
- The existing `DaytonaClient.executeTask()` in `src/cloud/daytona-client.ts` uses `CreateSandboxFromSnapshotParams` with `language: 'typescript'`. This should be updated to use `CreateSandboxFromImageParams` or pre-registered snapshot name for the harness image. [VERIFIED: daytona-client.ts line 89]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Lambda-to-Lambda via SQS is preferable to direct Lambda invocation for stage sequencing | Architecture Patterns | Low -- SQS provides durability and natural retry; direct invocation would still work but loses checkpoint boundary |
| A2 | Daytona default sandbox has Node.js 22 or can run Node.js 22 via `Image.base('node:22-slim')` | Standard Stack | Low -- `Image.base()` explicitly pulls the specified Docker image; the base image is Docker Hub standard |
| A3 | A single SQS queue can route to different stage handlers using message attributes or body parsing | Architecture Patterns | Low -- standard SQS pattern; alternatively use separate queues per stage |
| A4 | Daytona sandbox `process.executeCommand()` blocks until command completes and returns exit code + stdout | Architecture Patterns | Low -- confirmed by existing `DaytonaClient.executeTask()` implementation |
| A5 | Agent execution time will typically fit within Lambda's 15-minute timeout when using Daytona | Pitfalls | Medium -- some complex planning/execution tasks could exceed 15 min; async dispatch pattern may be needed |
| A6 | RDS connection limits are sufficient for concurrent Lambda invocations without RDS Proxy | Pitfalls | Medium -- depends on Lambda concurrency; may need RDS Proxy if concurrent pipelines exceed ~50 |

## Open Questions

1. **Lambda timeout vs Daytona execution time**
   - What we know: Lambda has a 15-minute hard limit. Daytona sandbox execution can take variable time depending on the agent task.
   - What's unclear: Whether all agent stages complete within 15 minutes, or if async dispatch with callback is needed.
   - Recommendation: Start with synchronous dispatch (Lambda waits for Daytona). Monitor execution times. If any stage consistently exceeds 10 minutes, refactor to async dispatch with a DynamoDB/SQS callback mechanism.

2. **Snapshot rebuild frequency**
   - What we know: D-08 says "rebuild when harness changes." No CI/CD for image builds.
   - What's unclear: How to detect when a snapshot is stale and needs rebuilding.
   - Recommendation: Embed a version string (git SHA or package.json version) in the snapshot's env vars. The orchestrator reads this from the snapshot metadata and logs a warning if it doesn't match the deployed orchestrator version.

3. **SQS queue topology: single queue or one per stage?**
   - What we know: D-02 says "SQS messages between stages." Could be one queue with stage routing or separate queues.
   - What's unclear: Whether a single queue with message attributes is sufficient or separate queues provide better isolation.
   - Recommendation: Start with a single stage queue. Add per-stage queues only if visibility timeout differences or priority requirements emerge.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Everything | Yes | 22.18.0 | -- |
| npm | Package management | Yes | (bundled with Node) | -- |
| TypeScript | Type checking | Yes | 6.0.2 | -- |
| AWS CDK | Infrastructure | Yes | (in infra/) | -- |
| @daytonaio/sdk | Sandbox lifecycle | Yes | 0.166.0 | -- |
| pg | Postgres client | Yes | 8.20.0 | -- |
| Daytona API | Agent runtime | External service | -- | Cannot test locally; needs API key |
| AWS Lambda | Stage execution | External service | -- | Local simulation via handler invocation |
| AWS SQS | Inter-stage messaging | External service | -- | Local simulation via direct handler calls |
| AWS RDS Postgres | Checkpoint storage | External service | -- | Local Postgres for testing |

**Missing dependencies with no fallback:**
- None -- all code dependencies are installed. AWS services and Daytona API are external and tested via integration tests.

**Missing dependencies with fallback:**
- Local testing can use direct function calls to simulate Lambda handlers without deploying to AWS.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.2 |
| Config file | vitest.config.ts (cloud-unit and cloud-integration projects) |
| Quick run command | `npx vitest run --project cloud-unit` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PIPE-01 | Pipeline stages execute in correct order (intake->research->plan->approve->execute->verify->PR) | unit | `npx vitest run src/cloud/test/stage-router.test.ts -x` | No -- Wave 0 |
| PIPE-04 | .planning/ context downloaded from S3 before agent runs, artifacts uploaded after | unit | `npx vitest run src/cloud/test/s3-sync.test.ts -x` | No -- Wave 0 |
| STATE-01 | Checkpoint written to agent_runs after every task; pipeline_runs updated after every stage | unit | `npx vitest run src/cloud/test/checkpoint.test.ts -x` | No -- Wave 0 |
| STATE-02 | Resume queries completed tasks and skips them; resumes from correct stage | unit | `npx vitest run src/cloud/test/resume.test.ts -x` | No -- Wave 0 |
| STATE-03 | Task ID is deterministic; UPSERT prevents duplicate rows on replay | unit | `npx vitest run src/cloud/test/idempotency.test.ts -x` | No -- Wave 0 |
| STATE-04 | Entrypoint downloads context, runs agent, uploads artifacts | unit | `npx vitest run src/cloud/test/entrypoint.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --project cloud-unit`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `src/cloud/test/stage-router.test.ts` -- covers PIPE-01
- [ ] `src/cloud/test/s3-sync.test.ts` -- covers PIPE-04
- [ ] `src/cloud/test/checkpoint.test.ts` -- covers STATE-01
- [ ] `src/cloud/test/resume.test.ts` -- covers STATE-02
- [ ] `src/cloud/test/idempotency.test.ts` -- covers STATE-03
- [ ] `src/cloud/test/entrypoint.test.ts` -- covers STATE-04

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Daytona API key + AWS IAM -- managed by Phase 1 infrastructure |
| V3 Session Management | No | Stateless Lambda invocations; no user sessions |
| V4 Access Control | Yes | IAM least-privilege policies for Lambda roles accessing S3, SQS, RDS, Daytona |
| V5 Input Validation | Yes | Type guards on SQS message bodies (existing pattern from sqs-consumer.ts) |
| V6 Cryptography | No | S3 server-side encryption and RDS SSL -- configured in Phase 1 |

### Known Threat Patterns for Lambda + SQS + Daytona

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQS message tampering | Tampering | SQS encryption at rest (SSE-SQS), VPC endpoint for in-transit |
| Excessive Lambda concurrency (cost attack) | Denial of Service | Lambda reserved concurrency limit + SQS maxReceiveCount |
| Daytona sandbox escape | Elevation of Privilege | Daytona's built-in isolation; no Docker-in-Docker; ephemeral sandboxes |
| S3 artifact overwrite | Tampering | Deterministic keys + S3 versioning (can enable if needed); SHA256 checksums on upload (existing in s3-artifacts.ts) |
| Secrets in environment variables | Information Disclosure | AWS Secrets Manager for API keys; environment variables scoped per sandbox invocation |
| SQL injection in checkpoint queries | Tampering | Parameterized queries (existing pattern in postgres-client.ts) |

## Sources

### Primary (HIGH confidence)
- `@daytonaio/sdk` 0.166.0 type definitions -- Daytona.d.ts, Image.d.ts, Snapshot.d.ts, Sandbox.d.ts [VERIFIED: node_modules inspection]
- `src/cloud/` Phase 1 service clients -- types.ts, daytona-client.ts, s3-artifacts.ts, postgres-client.ts, sqs-consumer.ts [VERIFIED: codebase read]
- `scripts/init-db-schema.sql` -- existing database schema [VERIFIED: codebase read]
- `sdk/src/` -- SDK public API, session runner, phase runner, types [VERIFIED: codebase read]
- `02-CONTEXT.md` -- all locked decisions D-01 through D-19 [VERIFIED: codebase read]

### Secondary (MEDIUM confidence)
- [Daytona Snapshots documentation](https://www.daytona.io/docs/en/snapshots/) -- snapshot creation, lifecycle, default packages [CITED]
- [Daytona TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/) -- API overview [CITED]
- [Daytona Sandboxes documentation](https://www.daytona.io/docs/en/sandboxes/) -- resource limits, auto-stop behavior [CITED]
- npm registry version verification for all packages [VERIFIED: npm view commands]

### Tertiary (LOW confidence)
- Lambda + RDS connection pool best practices [ASSUMED -- based on AWS standard guidance]
- SQS visibility timeout recommendation (6x Lambda timeout) [ASSUMED -- based on AWS best practices documentation]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all packages verified via npm registry and node_modules, existing Phase 1 code inspected
- Architecture: HIGH -- patterns derived from locked decisions in CONTEXT.md, verified against Daytona SDK type definitions
- Pitfalls: HIGH -- grounded in concrete code analysis (schema mismatch, Lambda timeout limits, connection pool behavior)

**Research date:** 2026-04-16
**Valid until:** 2026-05-16 (30 days -- stable architecture, locked decisions)

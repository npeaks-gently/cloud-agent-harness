# Cloud Agent Harness Architecture

> Architecture documentation for the cloud-native autonomous feature delivery platform.
> Reflects the implemented state as of Phase 3 completion (2026-04-17).

---

## Overview

The Cloud Agent Harness transforms a local CLI-based multi-agent workflow into a headless, cloud-hosted system. A user describes what they want, approves a plan in Slack, and gets a PR with the implementation -- no further human intervention required.

The system is built in 5 phases. Phases 1-3 are complete. Phases 4-5 are planned but not yet implemented.

```
                     WHAT EXISTS TODAY (Phases 1-3)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  infra/               CDK stack (VPC, S3, RDS, SQS, IAM, Lambda,   │
│                       API Gateway, VPC endpoints)                    │
│  src/cloud/           Service clients + pipeline orchestration       │
│  src/cloud/pipeline/  Stage router, 7 stage handlers, checkpoint    │
│  src/cloud/entrypoint/ Agent entrypoint + S3 context sync           │
│  src/cloud/snapshot/  Daytona image builder + snapshot manager       │
│  src/cloud/integrations/ Slack, GitHub, Linear SDK wrappers         │
│  src/cloud/webhook/   Slack webhook handler (signature verification) │
│  src/cloud/analytics.ts  PostHog event tracking utility              │
│  scripts/             DB schema, migrations, e2e validation          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

                         WHAT COMES NEXT (Phases 4-5)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Phase 4:  Headless auto-decisions, fully autonomous pipeline       │
│  Phase 5:  Observability dashboard, CLI status queries, telemetry   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Target Architecture

When complete, the system has four layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  INGESTION         Slack Bot  |  Linear Webhooks  |  CLI (local)   │
├─────────────────────────────────────────────────────────────────────┤
│  ORCHESTRATION     Lambda + SQS stage router                       │
│                    Job queue (intake) + Stage queue (progression)   │
├─────────────────────────────────────────────────────────────────────┤
│  EXECUTION         Daytona sandboxes running Claude Agent SDK       │
│                    Each agent: clone repo, execute, push artifacts  │
├─────────────────────────────────────────────────────────────────────┤
│  STORAGE           S3 (artifacts)  |  Postgres (state, telemetry)  │
│                    Secrets Manager (credentials)                    │
└─────────────────────────────────────────────────────────────────────┘
```

Agents never communicate directly. They read/write artifacts through S3 and the orchestrator sequences who runs when. This preserves the proven file-artifact communication pattern from the local GSD harness.

---

## Pipeline Architecture (Phase 2)

The pipeline is a 7-stage linear progression orchestrated by a Lambda function that consumes from two SQS queues. Each stage either runs inline (intake, approve, PR) or dispatches an agent to a Daytona sandbox (research, plan, execute, verify).

```
                        Pipeline Flow
                        ─────────────

  Job Queue (SQS)              Stage Queue (SQS)
       │                            │
       ▼                            ▼
  ┌─────────────────────────────────────────────┐
  │           Stage Router Lambda                │
  │  ┌─────────────────────────────────────┐     │
  │  │  PipelineJobMessage? ──► Intake     │     │
  │  │  StageMessage?       ──► Handler    │     │
  │  └─────────────────────────────────────┘     │
  │       │              │                       │
  │       ▼              ▼                       │
  │  STAGE_HANDLERS dispatch map                 │
  │  ┌─────┬──────┬─────┬───────┬──────┬────┐   │
  │  │Intk │Rsrch │Plan │Approv │Exec  │Ver │PR │
  │  │     │  ▼   │ ▼   │      │  ▼   │ ▼  │   │
  │  │     │Agent │Agent│      │Agent │Agnt│   │
  │  └─────┴──────┴─────┴───────┴──────┴────┘   │
  │       │                                      │
  │       ▼                                      │
  │  Post-handler: checkpoint + SQS next stage   │
  └─────────────────────────────────────────────┘
       │                    │
       ▼                    ▼
    Postgres             S3 Artifacts
  (state, runs)        (planning files)
```

### Stage Lifecycle

| Stage | Type | What it does |
|-------|------|-------------|
| **Intake** | Inline | Creates pipeline_run row, generates runId |
| **Research** | Daytona agent | Researches the feature domain |
| **Plan** | Daytona agent | Creates execution plans |
| **Approve** | Inline | Auto-approve placeholder (Phase 3 replaces with Slack) |
| **Execute** | Daytona agent | Iterates plans sequentially, skips completed (resume) |
| **Verify** | Daytona agent | Validates execution output |
| **PR** | Inline | PR placeholder (Phase 3 replaces with GitHub integration) |

### Checkpoint/Resume

Every agent task boundary writes a checkpoint to Postgres. If the pipeline dies mid-run:

1. `resumePipeline(runId)` queries the last completed stage and completed task keys
2. The stage router resumes from the last good stage
3. Within the execute stage, completed plans are skipped via idempotency keys (`runId:phase:plan:wave`)
4. Idempotency uses `ON CONFLICT (task_key) DO UPDATE` -- replaying a checkpoint produces no duplicates

### Agent Sandbox Execution

```
  Stage Router Lambda
       │
       ▼
  sandbox-task.ts
       │  1. Build task key (runId:phase:plan:wave)
       │  2. Check if already completed (skip)
       │  3. DaytonaClient.executeTask()
       │     └── Create sandbox (node:22-slim snapshot)
       │         Clone repo, inject CAH_* env vars
       │         Run agent-entrypoint.ts
       │         Return stdout + exit code
       │  4. Write checkpoint (success or failure)
       ▼
  agent-entrypoint.ts (inside Daytona sandbox)
       │  1. Read CAH_* env vars
       │  2. Download .planning/ from S3
       │  3. SDK dispatch by stage:
       │     research/plan/verify → gsd.runPhase()
       │     execute → gsd.executePlan()
       │  4. git diff --name-only HEAD
       │  5. Upload modified files to S3
       │  6. Write JSON result to stdout
       ▼
```

---

## Phase 3: Integrations (Planned)

Phase 3 connects the pipeline to four external systems. 5 plans across 3 waves.

```
                    Phase 3 Integration Points
                    ──────────────────────────

  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  Slack   │     │  GitHub  │     │  Linear  │     │ PostHog  │
  │ INTG-01  │     │ INTG-02  │     │ INTG-03  │     │ INTG-04  │
  └────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
       │                │                │                │
       ▼                ▼                ▼                ▼
  Approve stage    Intake + PR      Intake + Router   All stages
  + Webhook λ      + Merge exec     + PR stage        + Entrypoint
```

### Slack Approval Flow (INTG-01)

Replaces the auto-approve placeholder with a two-Lambda architecture:

```
  Approve Stage Handler                    Slack Webhook Lambda
  ─────────────────────                    ────────────────────
  1. Build Block Kit message               1. Verify HMAC-SHA256 signature
     (approve/reject buttons)              2. Check timestamp < 5 min (replay)
  2. Send via @slack/web-api               3. Validate token in Postgres
  3. Write pending approval row            4. Resolve approval
     to Postgres (UUID token)              5. On approve: SQS → Execute stage
  4. Return status: 'paused'               6. On reject: mark pipeline rejected
     (router does NOT advance)
                                           API Gateway (public endpoint)
                                           └── HMAC sig is the auth layer
                                               (Slack can't use VPC/IAM)
```

The stage router treats `'paused'` as terminal -- no SQS advancement. The webhook Lambda owns pipeline resumption.

### Git/PR Delivery (INTG-02)

- **Intake** creates a feature branch (`cah/{run_id_short}/{feature-slug}`)
- **Agent entrypoint** creates task branches, commits, and pushes to remote
- **Merge executor** merges task branches back into the feature branch in wave-DAG order
- **PR stage** opens a pull request from the feature branch to main with a structured description

### Linear Tracking (INTG-03)

- **Intake** creates a parent Linear ticket for the pipeline run
- **Stage router** creates sub-tickets per phase, updates status at stage transitions
- **PR stage** links the PR URL to the parent ticket and marks it done

### PostHog Instrumentation (INTG-04)

Thin analytics utility (`src/cloud/analytics.ts`, ~20-30 lines) wrapping `posthog-node`:
- `track(event, properties, distinctId?)` -- consistent event structure
- `flush()` -- must be called before every Lambda return (Lambda-specific: `flushAt: 1`, `flushInterval: 0`)
- Events: `pipeline_started`, `stage_completed`, `approval_requested`, `approval_approved/rejected`, `agent_run_completed` (with `costUsd`), `pr_created`

### Wave Structure

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1 | 03-01, 03-02 | Types + migration + PostHog utility; Slack/GitHub/Linear SDK wrappers |
| 2 | 03-03, 03-04 | Stage handler rewrites + merge executor; Agent entrypoint git push + CDK webhook construct |
| 3 | 03-05 | Slack webhook Lambda (signature verification, token validation, SQS resume) |

### New Infrastructure (CDK)

- **API Gateway HTTP API** -- public endpoint for Slack webhook callbacks
- **Slack Webhook Lambda** -- receives Slack interactive payloads, validates, resumes pipeline
- **Secrets Manager** -- Slack signing secret, Slack bot token, GitHub token, Linear API key, PostHog API key

---

## Phase 1: What Was Built

### AWS Infrastructure (`infra/`)

A single CDK stack (`CahStack`) deploys to `us-east-1` with a `cah-dev-*` naming prefix. One command (`npx aws-cdk deploy`) creates everything.

```
infra/
├── bin/cah.ts                       CDK app entry point
├── lib/
│   ├── cah-stack.ts                 Composes all constructs
│   └── constructs/
│       ├── networking.ts            VPC
│       ├── storage.ts               S3 bucket
│       ├── database.ts              RDS Postgres + Secrets Manager
│       ├── messaging.ts             SQS queue + DLQ
│       └── iam.ts                   IAM user + policy
└── test/cah-stack.test.ts           27 CDK assertion tests
```

#### Resource Details

| Resource | Configuration | Why |
|----------|--------------|-----|
| **VPC** | 10.0.0.0/16, 2 AZs, public + isolated subnets, 0 NAT gateways | NAT costs ~$32/mo for dev; isolated subnets available for future private resources |
| **S3 Bucket** | `cah-dev-pipeline-bucket`, SSE-S3 encryption, block all public access, DESTROY removal policy | Stores pipeline artifacts at `runs/{runId}/phases/{phase}/{fileName}` |
| **RDS Postgres 16** | `db.t4g.micro`, publicly accessible, SSL enforced via `rds.force_ssl=1`, auto-generated credentials in Secrets Manager | Publicly accessible because Daytona Cloud has no VPC peering; SSL compensates |
| **SQS** | `cah-dev-jobs` (900s visibility timeout, 4-day retention) + `cah-dev-jobs-dlq` (maxReceiveCount: 3, 14-day retention) | 15-min visibility matches agent task duration; DLQ catches poison messages |
| **IAM** | User `cah-dev-agent` with policy scoped to specific bucket/queue/secret ARNs | Least-privilege: S3 get/put/list, SQS receive/delete, Secrets Manager get. No wildcards. Access key stored in Secrets Manager. |
| **Secrets Manager** | Two secrets: RDS credentials (auto-generated) + agent access key | Credentials never in code or CloudFormation template output |

#### Dependency Wiring

```
CahStack
  ├── CahNetworking (vpc)
  ├── CahStorage (bucket)
  ├── CahDatabase (vpc) ──► uses vpc from Networking
  ├── CahMessaging (queue, dlq)
  └── CahIam (user, policy) ──► scoped to bucket ARN, queue ARN, secret ARN
```

Stack outputs: `BucketName`, `DbEndpoint`, `QueueUrl`, `SecretArn`.

### Cloud Service Clients (`src/cloud/`)

TypeScript modules that agent code uses to interact with deployed infrastructure. These are the application-level bridge -- agents import these to store artifacts, persist state, receive jobs, and execute inside sandboxes.

```
src/cloud/
├── types.ts                         Shared domain types
├── daytona-client.ts                Sandbox lifecycle manager
├── s3-artifacts.ts                  Artifact upload/download/list
├── postgres-client.ts               Connection pool + typed queries
├── sqs-consumer.ts                  Job message consumer
└── test/                            41 unit tests (mocked externals)
    ├── daytona-client.test.ts
    ├── s3-artifacts.test.ts
    ├── postgres-client.test.ts
    └── sqs-consumer.test.ts
```

#### `types.ts` -- Domain Types

| Type | Purpose |
|------|---------|
| `PipelineRun` | Tracks a pipeline execution: project, status, current/total phases, config |
| `AgentRun` | Tracks a single agent task: pipeline run, phase, wave, tokens, cost, duration |
| `AgentTaskConfig` | Input to Daytona: repo URL, branch, env vars, command, timeout, resources |
| `AgentTaskResult` | Output from Daytona: exit code, stdout, duration |
| `ArtifactKey` | S3 path components: run ID, phase, file name |
| `PipelineJobMessage` | SQS message payload: project, repo, branch, feature description |

#### `daytona-client.ts` -- Sandbox Lifecycle

```
DaytonaClient.executeTask(config)
  1. Create sandbox (2 vCPU / 4 GB default)
  2. Clone repo into /home/daytona/workspace
  3. Execute command with env vars
  4. Return { exitCode, stdout, durationMs }
  5. ALWAYS delete sandbox in finally block (prevents cost leaks)
```

The SDK instance is reused across calls. All errors wrapped in `DaytonaClientError` with operation name and sandbox ID.

#### `s3-artifacts.ts` -- Artifact Storage

Three pure async functions (not class-based):

- `uploadArtifact(bucket, key, content)` -- PutObject with SHA256 checksum
- `downloadArtifact(bucket, key)` -- GetObject, returns Buffer
- `listArtifacts(bucket, runId, phase)` -- ListObjectsV2, returns file names

Key path pattern: `runs/{runId}/phases/{phase}/{fileName}`

All accept an optional S3Client parameter for testability.

#### `postgres-client.ts` -- State Persistence

- `createDbPool(connectionString)` -- Pool with `ssl: { rejectUnauthorized: true }`, max 5 connections
- `insertPipelineRun(pool, projectId, phaseTotal, config)` -- Returns generated UUID
- `getPipelineRun(pool, id)` -- Maps snake_case DB columns to camelCase TypeScript
- `insertAgentRun(pool, pipelineRunId, phase, planName, wave)` -- Status starts as 'running'
- `updateAgentRun(pool, id, update)` -- Dynamic SET clause, auto-sets `completed_at` on terminal status

All queries use parameterized placeholders (`$1`, `$2`). No string interpolation in SQL.

#### `sqs-consumer.ts` -- Job Intake

```
SqsConsumer
  .receiveMessage()  -- Long-polls (20s), validates with type guard, returns parsed message + receipt handle
  .deleteMessage()   -- Acknowledges processing complete
```

Type guard `isPipelineJobMessage()` validates required fields before processing. Invalid messages throw `SqsConsumerError`.

### Database Schema (`scripts/init-db-schema.sql`)

```sql
pipeline_runs
  id            UUID (PK, auto-generated)
  project_id    TEXT
  status        TEXT (pending | running | completed | failed)
  phase_current INTEGER
  phase_total   INTEGER
  config        JSONB
  created_at    TIMESTAMPTZ
  updated_at    TIMESTAMPTZ (auto-updated via trigger)

agent_runs
  id              UUID (PK, auto-generated)
  pipeline_run_id UUID (FK -> pipeline_runs)
  phase           INTEGER
  plan_name       TEXT
  wave            INTEGER
  status          TEXT
  session_id      TEXT
  model           TEXT
  input_tokens    INTEGER
  output_tokens   INTEGER
  cost_usd        NUMERIC(10,6)
  duration_ms     INTEGER
  error_message   TEXT
  artifacts       JSONB
  started_at      TIMESTAMPTZ
  completed_at    TIMESTAMPTZ
  created_at      TIMESTAMPTZ
```

Indexes on `agent_runs(pipeline_run_id)`, `agent_runs(status)`, `pipeline_runs(status)`.

### End-to-End Validation (`scripts/validate-phase1.ts`)

A runnable script that proves the full chain works against deployed infrastructure. Requires real AWS credentials and service endpoints. Tests:

1. **INFRA-02**: Daytona sandbox create/execute/teardown
2. **INFRA-03**: S3 artifact upload + download round-trip with content verification
3. **INFRA-04**: Postgres insert + query for pipeline_runs and agent_runs
4. **INFRA-05**: SQS send + receive + delete message cycle

### Test Configuration (`vitest.config.ts`)

5 test projects:

| Project | Scope | What it covers |
|---------|-------|----------------|
| `unit` | `sdk/src/**/*.test.ts` | Existing SDK unit tests |
| `integration` | `sdk/src/**/*.integration.test.ts` | Existing SDK integration tests |
| `infra-unit` | `infra/test/**/*.test.ts` | CDK assertion tests (27 tests) |
| `cloud-unit` | `src/cloud/test/**/*.test.ts` | Cloud client unit tests (41 tests) |
| `cloud-integration` | `src/cloud/**/*.integration.test.ts` | Cloud integration tests (future) |

---

## Phase 2: What Was Built

### Pipeline Types & Idempotency (`src/cloud/pipeline/`)

```
src/cloud/pipeline/
├── types.ts              PipelineStage enum (7 stages), StageMessage, StageResult,
│                         NEXT_STAGE transition map, PipelineError
├── idempotency.ts        buildTaskId(), upsertAgentRun(), getCompletedTasks()
├── checkpoint.ts         writeAgentCheckpoint(), updatePipelineStage(), getPipelineState()
├── resume.ts             resumePipeline() -- returns stage + completed keys to skip
├── sandbox-task.ts       runAgentTask() -- Daytona dispatch with checkpoint writes
├── stage-router.ts       Lambda entry point: dual type guard SQS dispatch
└── stages/
    ├── intake.ts          Creates pipeline_run row (INSERT ON CONFLICT DO NOTHING)
    ├── research.ts        Dispatches research agent to Daytona sandbox
    ├── plan.ts            Dispatches planning agent to Daytona sandbox
    ├── approve.ts         Auto-approve placeholder (Phase 3: Slack)
    ├── execute.ts         Iterates plans sequentially, skips completed
    ├── verify.ts          Dispatches verifier agent to Daytona sandbox
    └── pr.ts              PR placeholder (Phase 3: GitHub)
```

#### Pipeline Type System

| Type | Purpose |
|------|---------|
| `PipelineStage` | Enum: Intake, Research, Plan, Approve, Execute, Verify, PR |
| `NEXT_STAGE` | Transition map: Intake->Research->Plan->Approve->Execute->Verify->PR->null |
| `StageMessage` | SQS inter-stage payload: runId, projectId, repoUrl, branch, stage, context |
| `StageResult` | Handler return: status (`completed`, `failed`, `skipped`), optional artifacts/error |
| `PipelineError` | Shared error class with operation + stage context |

#### Stage Router

The router Lambda consumes from two SQS queues using dual type guards:

- **Job queue**: `isPipelineJobMessage()` -- generates runId via `crypto.randomUUID()`, converts to StageMessage, dispatches to intake
- **Stage queue**: `isStageMessage()` -- dispatches to correct handler via `STAGE_HANDLERS` map

Post-handler: writes checkpoint via `updatePipelineStage()`, sends next-stage SQS message unless terminal (PR) or failed.

#### Idempotency

- `buildTaskId(runId, phase, plan, wave)` -- deterministic colon-separated key
- `upsertAgentRun()` -- `INSERT ON CONFLICT (task_key) DO UPDATE` with `started_at` preservation
- `getCompletedTasks()` -- query completed task keys with optional stage LIKE filter

### Agent Entrypoint & S3 Sync (`src/cloud/entrypoint/`)

```
src/cloud/entrypoint/
├── agent-entrypoint.ts   Sandbox entry point: env vars -> S3 download -> SDK dispatch -> upload
├── s3-sync.ts            downloadPlanningDir() + uploadModifiedFiles()
└── sdk-loader.ts         Thin wrapper for dynamic SDK import (testability)
```

- **Config via `CAH_*` env vars**: `CAH_RUN_ID`, `CAH_STAGE`, `CAH_PHASE`, `CAH_PLAN`, `CAH_BUCKET`, `CAH_REPO_URL`, `CAH_BRANCH`
- **SDK dispatch by stage**: research/plan/verify -> `gsd.runPhase()`, execute -> `gsd.executePlan()`
- **Artifact flow**: download `.planning/` from S3 at start, `git diff` for modified files, upload to S3 at end

### Daytona Snapshot (`src/cloud/snapshot/`)

```
src/cloud/snapshot/
├── image-builder.ts      Declarative Image.base('node:22-slim') with git, npm ci, entrypoint
└── snapshot-manager.ts   createOrUpdateSnapshot('cah-harness-v1', 300s timeout)
```

### Pipeline Lambda CDK Construct (`infra/lib/constructs/pipeline-lambda.ts`)

- **Stage Queue** (internal SQS): 900s visibility timeout matching Lambda timeout, DLQ with maxReceiveCount 3
- **Lambda**: Node.js 22, 900s timeout, 512MB memory, reserved concurrency 10, VPC PRIVATE_ISOLATED placement
- **IAM**: 4 least-privilege policy statements (S3, SQS, SecretsManager-DB, SecretsManager-Anthropic)
- **Security Group**: Dedicated Lambda SG with ingress rule on DB security group for port 5432
- **Event Sources**: Job queue (batchSize: 1) + stage queue (batchSize: 1)
- **Env vars**: `STAGE_QUEUE_URL`, `ANTHROPIC_API_KEY_SECRET_ARN` (ARN only, not raw key), `DB_SECRET_ARN`

### Database Migration (`scripts/migrate-002-idempotency.sql`)

| Column | Table | Purpose |
|--------|-------|---------|
| `task_key` | `agent_runs` | Deterministic idempotency key (unique partial index) |
| `current_stage` | `pipeline_runs` | Stage tracking for checkpoint/resume |
| `repo_url`, `branch`, `feature_description` | `pipeline_runs` | Pipeline context propagation |

### Test Coverage (Phase 2)

| Test File | Tests | What it covers |
|-----------|-------|----------------|
| `idempotency.test.ts` | 9 | buildTaskId, upsertAgentRun, getCompletedTasks |
| `s3-sync.test.ts` | 6 | Download/upload with edge cases |
| `entrypoint.test.ts` | 13 | Env validation, S3 download, per-stage dispatch, upload, JSON output |
| `checkpoint.test.ts` | 10 | Checkpoint writes, stage updates, state queries |
| `resume.test.ts` | 3 | Partial resume, new run, missing run |
| `stage-router.test.ts` | 11 | StageMessage routing, intake, post-handler, type guards |
| `pipeline-lambda.test.ts` | 14 | CDK assertions: timeout, runtime, IAM, env, outputs, synth |

66 new tests across Phase 2 (107 total including Phase 1).

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent runtime | Daytona sandboxes (not ECS/Lambda) | Each agent gets a full dev environment with git, shell, and filesystem. No 15-min Lambda timeout. Daytona handles provisioning. |
| Storage model | S3 for artifacts, Postgres for state (no EFS) | Agents pull/push explicitly. No shared filesystem coupling. Simpler than EFS VPC requirements. |
| CDK over Terraform | CDK with TypeScript | Team writes TypeScript. Type-safe constructs. Single language across infra and app code. |
| Single stack | One `CahStack` | Dev environment simplicity. Can split per-concern later if needed. |
| Public RDS | Publicly accessible with SSL | Daytona Cloud has no VPC peering. SSL enforcement via parameter group compensates. |
| No NAT gateway | Public subnets only | Saves ~$32/mo for dev. Isolated subnets available for future private resources. |
| IAM user (not role) | Access key in Secrets Manager | Daytona uses access keys. Key stored in Secrets Manager, not in code or CFN output. |
| Lambda+SQS (not Step Functions) | SQS-driven stage progression | Simpler than Step Functions for linear pipelines. Checkpoint/resume via Postgres. SQS visibility timeout matches Lambda timeout (900s). |
| Dual SQS queues | Job queue (intake) + stage queue (progression) | Separates external triggers from internal stage advancement. Different retry/DLQ policies per concern. |
| Sequential plan execution | Plans iterated in order, not parallel | v1 simplicity. Wave-based parallel execution deferred to v2. |
| Slack webhook HMAC (not VPC) | Public API Gateway + HMAC-SHA256 signature verification | Slack servers must reach the callback URL -- no VPC peering option. HMAC + replay protection (5-min window) + timing-safe comparison is Slack's recommended auth model. |
| Postgres approval tokens (not Step Functions callbacks) | UUID token in `approvals` table, webhook validates and re-enqueues SQS | Keeps the pipeline stateless between stages. No long-lived Step Functions execution to manage. Webhook Lambda owns resumption. |
| Thin PostHog utility (not abstraction layer) | ~20-30 line wrapper: init, track(), flush() | Lambda-specific config (`flushAt: 1`, `flushInterval: 0`). Each stage calls `track()` directly. Can grow if needed but starts minimal. |

---

## Security Model

| Boundary | Threat | Mitigation |
|----------|--------|------------|
| Daytona -> RDS (public internet) | Credential interception | SSL enforced via `rds.force_ssl=1`; credentials in Secrets Manager |
| Daytona -> S3 | Data tampering in transit | SHA256 checksums on upload; IAM-scoped access |
| SQS message body -> app | Untrusted input | Dual type guards validate all required fields before processing |
| IAM agent policy | Privilege escalation | Least-privilege: specific resource ARNs only, no wildcards |
| IAM access key | Key exposure | Stored in Secrets Manager via `secretObjectValue`, never in plaintext CFN output |
| S3 bucket | Public access | `BlockPublicAccess.BLOCK_ALL`; SSE-S3 encryption at rest |
| SQS queue | Poison messages | DLQ after 3 failed receives; 15-min visibility timeout |
| Lambda -> Anthropic API key | Key in environment | ARN stored in env, not raw key. Lambda fetches via SecretsManager at runtime |
| Lambda -> RDS | Network access | Lambda in PRIVATE_ISOLATED subnets; dedicated security group with port 5432 ingress only |
| Lambda concurrency | Runaway invocations | Reserved concurrency 10; stage DLQ maxReceiveCount 3 |
| Sandbox stdout -> orchestrator | Malformed output injection | JSON parse wrapped in try/catch; fallback to exit code on parse failure |
| Slack webhook (Phase 3) | Forged callback / replay | HMAC-SHA256 via `timingSafeEqual`; 5-min timestamp window; approval token validated in Postgres |
| Slack webhook -> SQS | Unauthorized pipeline resume | SQS message only sent on valid approval; IAM restricts Lambda to SendMessage on stage queue only |

---

## What's Not Built Yet

| Component | Phase | Status | Purpose |
|-----------|-------|--------|---------|
| Slack approval | 3 | Planned (wave 1-3) | Block Kit approve/reject buttons, webhook Lambda for pipeline resume |
| GitHub PR delivery | 3 | Planned (wave 2) | Feature branch, task branches, merge executor, structured PR |
| Linear tracking | 3 | Planned (wave 1-2) | Parent ticket at intake, sub-tickets per phase, status at transitions |
| PostHog events | 3 | Planned (wave 1-2) | Pipeline events, agent run cost/tokens, stage transitions |
| Auto-decision agent | 4 | Not started | LLM handles routine decisions, escalates high-risk to Slack |
| CLI status queries | 5 | Not started | `cah status`, `cah runs`, `cah run <id>` |
| Per-agent telemetry | 5 | Not started | Tool calls, output references, token usage in Postgres |

### Deferred to v2

| Component | Reason |
|-----------|--------|
| Wave-based parallel execution | v1 executes plans sequentially for simplicity |
| Code review agent (FEED-01) | Feedback loops deferred at roadmap creation |
| Verifier rejection loop (FEED-02) | Feedback loops deferred at roadmap creation |
| Adaptive replanning (FEED-03) | Feedback loops deferred at roadmap creation |
| Multi-model routing (EXEC-01) | Single model sufficient for v1 |
| Token budget with alerts (EXEC-03) | Observability first, then budget enforcement |

---

*Last updated: 2026-04-16 (Phase 2 complete, Phase 3 planned)*

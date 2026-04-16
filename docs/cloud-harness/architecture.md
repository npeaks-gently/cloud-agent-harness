# Cloud Agent Harness Architecture

> Architecture documentation for the cloud-native autonomous feature delivery platform.
> Reflects the implemented state as of Phase 1 completion (2026-04-16).

---

## Overview

The Cloud Agent Harness transforms a local CLI-based multi-agent workflow into a headless, cloud-hosted system. A user describes what they want, approves a plan in Slack, and gets a PR with the implementation -- no further human intervention required.

The system is built in 5 phases. Phase 1 (AWS Foundation & Agent Runtime) is complete. Phases 2-5 are planned but not yet implemented.

```
                          WHAT EXISTS TODAY (Phase 1)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  infra/               AWS CDK stack (VPC, S3, RDS, SQS, IAM)       │
│  src/cloud/           Service clients (Daytona, S3, Postgres, SQS)  │
│  scripts/             DB schema + e2e validation script              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

                          WHAT COMES NEXT (Phases 2-5)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Phase 2:  Step Functions orchestrator + checkpoint/resume           │
│  Phase 3:  Slack approval, GitHub PR delivery, Linear, PostHog      │
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
│  ORCHESTRATION     Step Functions state machine                     │
│                    SQS task queue  |  EventBridge status events     │
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

---

## Security Model

| Boundary | Threat | Mitigation |
|----------|--------|------------|
| Daytona -> RDS (public internet) | Credential interception | SSL enforced via `rds.force_ssl=1`; credentials in Secrets Manager |
| Daytona -> S3 | Data tampering in transit | SHA256 checksums on upload; IAM-scoped access |
| SQS message body -> app | Untrusted input | Type guard validates all required fields before processing |
| IAM agent policy | Privilege escalation | Least-privilege: specific resource ARNs only, no wildcards |
| IAM access key | Key exposure | Stored in Secrets Manager via `secretObjectValue`, never in plaintext CFN output |
| S3 bucket | Public access | `BlockPublicAccess.BLOCK_ALL`; SSE-S3 encryption at rest |
| SQS queue | Poison messages | DLQ after 3 failed receives; 15-min visibility timeout |

---

## What's Not Built Yet

| Component | Phase | Purpose |
|-----------|-------|---------|
| Step Functions state machine | 2 | Pipeline orchestration (research -> plan -> approve -> execute -> verify -> PR) |
| Checkpoint/resume | 2 | Recover from mid-pipeline failures without restarting |
| Storage abstraction | 2 | Agents pull context from S3 at start, push artifacts at end |
| Slack approval | 3 | Block Kit approve/reject buttons, Step Functions wait-for-callback |
| GitHub PR delivery | 3 | Feature branch, atomic commits, structured PR description |
| Linear tracking | 3 | Ticket status updates at phase transitions |
| PostHog events | 3 | Pipeline events, token usage, cost tracking |
| Auto-decision agent | 4 | LLM handles routine decisions, escalates high-risk to Slack |
| CLI status queries | 5 | `cah status`, `cah runs`, `cah run <id>` |
| Per-agent telemetry | 5 | Tool calls, output references, token usage in Postgres |

---

*Last updated: 2026-04-16 (Phase 1 complete)*

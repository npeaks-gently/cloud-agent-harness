# Phase 1: AWS Foundation & Agent Runtime - Research

**Researched:** 2026-04-15
**Domain:** AWS Infrastructure (CDK), Daytona sandbox provisioning, cloud storage (S3/Postgres), messaging (SQS)
**Confidence:** HIGH

## Summary

Phase 1 provisions all AWS infrastructure via CDK and validates end-to-end agent execution inside Daytona sandboxes using cloud storage. The stack is well-understood: AWS CDK v2 (2.250.0) for IaC, RDS Postgres for state, S3 for artifacts, SQS with DLQ for job intake, and the Daytona TypeScript SDK (`@daytonaio/sdk` 0.166.0) for sandbox lifecycle management.

The critical architectural decision is **Daytona-to-RDS connectivity**. Daytona Cloud sandboxes run on Daytona's managed infrastructure (not inside the user's AWS VPC) and do not provide static egress IPs. This means RDS must either be publicly accessible (with SSL enforcement + Secrets Manager credentials) or accessed via an intermediate proxy. For a dev environment with solo/small team constraints, publicly accessible RDS with SSL-enforced connections and Secrets Manager-rotated credentials is the pragmatic choice -- it avoids operational complexity of VPN tunnels or customer-managed compute (which is currently experimental in Daytona).

**Primary recommendation:** Use CDK single-stack deployment with publicly accessible RDS (SSL-enforced, Secrets Manager credentials), S3 with prefix-based artifact layout, and SQS with DLQ. Daytona sandboxes connect via internet with credentials injected as environment variables at sandbox creation time.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** CDK code lives in `infra/` at the repo root -- a dedicated top-level directory alongside `sdk/`, `commands/`, `agents/`
- **D-02:** Single CDK stack containing all resources (VPC, S3, RDS, SQS, IAM, Secrets Manager). No multi-stack splitting for v1
- **D-03:** CDK written in TypeScript to match the existing SDK codebase
- **D-04:** AWS resource naming follows project prefix + environment pattern: `cah-dev-{resource}` (e.g., `cah-dev-pipeline-bucket`, `cah-dev-agent-db`)
- **D-05:** One Daytona workspace per agent task -- maximum isolation, aligns with the existing fresh-context-per-agent architecture pattern
- **D-06:** Target codebase enters the workspace via git clone at workspace start -- agents get a real repo with full git history, enabling direct commits
- **D-07:** Workspaces are torn down immediately after agent completion -- artifacts are already pushed to S3/Postgres, no need to keep workspaces alive
- **D-08:** Phase 1 validation uses a simple SDK query task -- a minimal agent that calls the Claude API via claude-agent-sdk, reads a file, and writes an artifact to S3. This proves the full chain (workspace provisioning, API access, artifact storage, teardown) without depending on the full GSD pipeline
- **D-09:** Dev environment only for v1 -- single environment minimizes cost and ops overhead. Staging/prod added when pipeline is proven
- **D-10:** Single AWS account with resource tagging (`Environment=dev`) -- no AWS Organizations complexity for v1
- **D-11:** AWS region: us-east-1 -- broadest service availability, lowest latency to Anthropic API
- **D-12:** S3 key structure: `runs/{run_id}/phases/{phase}/` -- organized by pipeline run, then by phase. Maps naturally to pipeline lifecycle
- **D-13:** S3 versioning off for v1 -- artifacts are written once per agent run, keeps costs down
- **D-14:** No auto-delete lifecycle rule for v1 -- keep everything, add TTL when storage grows
- **D-15:** Single bucket with prefix separation: `runs/` for pipeline artifacts, `codebase/` for the codebase map

### Claude's Discretion
- VPC subnet topology (public/private), security group configuration, and NAT gateway setup
- RDS instance sizing, backup retention, and parameter group settings
- SQS queue configuration (visibility timeout, max receive count, DLQ settings)
- Secrets Manager secret structure and rotation policy
- IAM role and policy design (least-privilege boundaries for Daytona workspaces)
- CDK construct organization within the single stack

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFRA-01 | AWS foundation provisioned via CDK (VPC for RDS, S3 buckets, Secrets Manager, IAM roles) | CDK v2 single-stack pattern with all L2 constructs researched; VPC topology, S3 bucket, IAM, Secrets Manager patterns documented |
| INFRA-02 | RDS Postgres instance for runtime state, checkpoints, and agent session telemetry | RDS DatabaseInstance with Postgres 16, Secrets Manager credentials, SSL enforcement; base schema (pipeline_runs, agent_runs) design documented |
| INFRA-03 | S3 bucket for durable artifact storage (.planning/ files, codebase maps) | S3 bucket with prefix separation, SSE-S3 encryption, CORS for SDK access; upload/download patterns via @aws-sdk/client-s3 documented |
| INFRA-04 | Daytona workspace provisioning for agent tasks via API (create, execute, teardown) | @daytonaio/sdk 0.166.0 lifecycle documented: create() with envVars, git.clone(), process.executeCommand(), delete(); connectivity model to RDS/S3 analyzed |
| INFRA-05 | SQS queue for pipeline job intake with dead letter handling | SQS Queue + DLQ pattern with CDK, visibility timeout, maxReceiveCount; consumer pattern documented |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Infrastructure provisioning (VPC, S3, RDS, SQS) | CDK / CloudFormation | -- | IaC is the standard for repeatable AWS provisioning |
| Agent task execution | Daytona Sandbox | -- | Sandboxes provide isolated compute per agent task (D-05) |
| Artifact storage (upload/download) | S3 | Daytona filesystem (temp) | S3 is durable store; Daytona fs is ephemeral working space |
| Runtime state persistence | RDS Postgres | -- | Relational model for pipeline_runs/agent_runs (INFRA-02) |
| Job intake / message delivery | SQS | -- | Decouples producers from consumers with DLQ for failed messages |
| Credential management | Secrets Manager | IAM roles | Secrets Manager stores DB creds + API keys; IAM controls access |
| Network connectivity (Daytona to AWS) | Public internet (SSL) | -- | Daytona Cloud has no VPC peering; public RDS + SSL is required |
| Codebase delivery to agents | Git (via Daytona) | S3 (codebase map) | D-06 specifies git clone at workspace start |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| aws-cdk-lib | 2.250.0 | CDK v2 monolithic library for all AWS constructs | [VERIFIED: npm registry] Official AWS CDK library; single import for all L2 constructs |
| constructs | 10.6.0 | CDK construct base class | [VERIFIED: npm registry] Required peer dependency for aws-cdk-lib |
| aws-cdk (CLI) | 2.1118.0 | CDK CLI for synth/deploy/diff | [VERIFIED: npx cdk --version] Already available in dev environment |
| @daytonaio/sdk | 0.166.0 | Daytona TypeScript SDK for sandbox lifecycle | [VERIFIED: npm registry] Official SDK; create/execute/teardown sandboxes |
| @aws-sdk/client-s3 | 3.1030.0 | S3 operations from application code | [VERIFIED: npm registry] AWS SDK v3 modular client for S3 |
| @aws-sdk/client-sqs | 3.1030.0 | SQS operations from application code | [VERIFIED: npm registry] AWS SDK v3 modular client for SQS |
| @aws-sdk/client-secrets-manager | 3.1030.0 | Retrieve secrets at runtime | [VERIFIED: npm registry] AWS SDK v3 for Secrets Manager |
| pg | 8.20.0 | PostgreSQL client for Node.js | [VERIFIED: npm registry] De facto standard Postgres driver for Node.js |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @aws-sdk/lib-storage | 3.1030.0 | Multipart S3 uploads | When uploading large artifacts (>5MB) |
| @types/pg | 8.20.0 | TypeScript types for pg | Development time -- type safety for Postgres queries |
| ts-node | 10.9.2 | TypeScript execution for CDK | CDK needs `ts-node` to transpile TypeScript stacks on the fly |
| typescript | ^5.7.0 | TypeScript compiler for infra/ | Already in the project; CDK infra needs its own tsconfig |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pg (raw driver) | Prisma / Drizzle ORM | ORM adds abstraction overhead; raw pg is lighter for 2 tables and keeps dependency footprint small for v1 |
| Publicly accessible RDS | VPN tunnel / RDS Proxy | VPN adds ops burden; RDS Proxy costs $0.015/vCPU-hr; both overkill for dev environment |
| Single CDK stack | Multi-stack (network + data + compute) | Multi-stack adds cross-stack reference complexity; unnecessary for v1 scale (D-02) |
| Daytona Cloud | Customer-managed Daytona on AWS | Customer-managed compute is experimental and requires contacting Daytona support; not viable for v1 |

**Installation (infra/):**
```bash
npm install aws-cdk-lib constructs
npm install -D typescript ts-node @types/node
```

**Installation (sdk/ or root):**
```bash
npm install @daytonaio/sdk @aws-sdk/client-s3 @aws-sdk/client-sqs @aws-sdk/client-secrets-manager @aws-sdk/lib-storage pg
npm install -D @types/pg
```

**Version verification:** All versions verified against npm registry on 2026-04-15.

## Architecture Patterns

### System Architecture Diagram

```
                                    +------------------+
                                    |  Pipeline Trigger |
                                    |  (CLI / API)     |
                                    +--------+---------+
                                             |
                                             v
+-------------------------------------------+-------------------------------------------+
|                               AWS Account (us-east-1)                                  |
|                                                                                        |
|  +------------------+    +-------------------+    +------------------+                  |
|  |   SQS Queue      |    |  Secrets Manager  |    |    S3 Bucket     |                  |
|  |  cah-dev-jobs     |--->|  DB creds         |    |  cah-dev-        |                  |
|  |                   |    |  API keys         |    |  pipeline-bucket |                  |
|  |  DLQ: cah-dev-    |    |  Daytona token    |    |  /runs/{id}/...  |                  |
|  |    jobs-dlq       |    +-------------------+    |  /codebase/...   |                  |
|  +------------------+              |               +--------+---------+                  |
|                                    |                        ^  |                         |
|  +-----------------------------+   |                        |  |                         |
|  |  VPC (10.0.0.0/16)         |   |                        |  |                         |
|  |                             |   |                        |  |                         |
|  |  +-- Public Subnet ------+ |   |                        |  |                         |
|  |  | Internet Gateway      | |   |                        |  |                         |
|  |  +-- Isolated Subnet ---+ |   |                        |  |                         |
|  |  | RDS Postgres          | |   |                        |  |                         |
|  |  | cah-dev-agent-db      |<----+                        |  |                         |
|  |  | (publicly accessible) | |                             |  |                         |
|  |  | SSL enforced          | |                             |  |                         |
|  |  +-----------------------+ |                             |  |                         |
|  +-----------------------------+                            |  |                         |
+-------------------------------------------------------------+--+-------------------------+
                        ^   |                                 |  |
                        |   | (internet, SSL)                 |  |
                        |   v                                 |  v
+-------------------------------------------+-------------------------------------------+
|                        Daytona Cloud                                                   |
|                                                                                        |
|  +-- Sandbox (per agent task) ------------------------------------------+              |
|  |                                                                       |              |
|  |  1. git clone <target-repo>                                          |              |
|  |  2. Download artifacts from S3 (runs/{id}/phases/{phase}/)           |              |
|  |  3. Execute agent task (claude-agent-sdk query())                    |              |
|  |  4. Write results to Postgres (agent_runs)                           |              |
|  |  5. Upload artifacts to S3                                           |              |
|  |  6. Push git commits to remote                                       |              |
|  |                                                                       |              |
|  |  Environment: ANTHROPIC_API_KEY, DATABASE_URL, S3_BUCKET,            |              |
|  |               AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY               |              |
|  +-----------------------------------------------------------------------+              |
|  (sandbox created -> executed -> deleted)                                               |
+----------------------------------------------------------------------------------------+
```

### Recommended Project Structure

```
infra/
  bin/
    cah.ts                    # CDK app entry point
  lib/
    cah-stack.ts              # Single stack with all resources
    constructs/
      networking.ts           # VPC, subnets, security groups
      storage.ts              # S3 bucket configuration
      database.ts             # RDS instance + secrets
      messaging.ts            # SQS queue + DLQ
      iam.ts                  # IAM roles and policies
  test/
    cah-stack.test.ts         # CDK assertion tests
  cdk.json                    # CDK configuration
  tsconfig.json               # TypeScript config for CDK
  package.json                # CDK dependencies
src/
  cloud/
    daytona-client.ts         # Daytona SDK wrapper (create/execute/teardown)
    s3-artifacts.ts           # S3 upload/download for .planning/ files
    postgres-client.ts        # pg connection pool + base queries
    sqs-consumer.ts           # SQS message consumer
    types.ts                  # Shared types (PipelineRun, AgentRun, etc.)
  cloud/test/
    daytona-client.test.ts    # Unit tests (mocked SDK)
    s3-artifacts.test.ts      # Unit tests (mocked S3)
    postgres-client.test.ts   # Unit tests (mocked pg)
    sqs-consumer.test.ts      # Unit tests (mocked SQS)
scripts/
  validate-phase1.ts          # End-to-end validation script (D-08)
  init-db-schema.sql          # Base Postgres schema (pipeline_runs, agent_runs)
```

### Pattern 1: CDK Single Stack with Construct Composition

**What:** Organize CDK resources into logical constructs within a single stack, each responsible for a domain (networking, storage, database, messaging, IAM).
**When to use:** Always for v1 -- locked decision D-02.
**Example:**
```typescript
// Source: CDK best practices guide + verified patterns
// infra/lib/cah-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CahNetworking } from './constructs/networking.js';
import { CahStorage } from './constructs/storage.js';
import { CahDatabase } from './constructs/database.js';
import { CahMessaging } from './constructs/messaging.js';

export class CahStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const prefix = 'cah-dev';

    const networking = new CahNetworking(this, 'Networking', { prefix });
    const storage = new CahStorage(this, 'Storage', { prefix });
    const database = new CahDatabase(this, 'Database', {
      prefix,
      vpc: networking.vpc,
    });
    const messaging = new CahMessaging(this, 'Messaging', { prefix });

    // Outputs for validation
    new cdk.CfnOutput(this, 'BucketName', { value: storage.bucket.bucketName });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: database.instance.instanceEndpoint.hostname });
    new cdk.CfnOutput(this, 'QueueUrl', { value: messaging.queue.queueUrl });
    new cdk.CfnOutput(this, 'SecretArn', { value: database.secret.secretArn });
  }
}
```

### Pattern 2: Daytona Sandbox Lifecycle (Create -> Execute -> Teardown)

**What:** Wrap @daytonaio/sdk to create a sandbox, inject credentials, execute an agent task, then tear down.
**When to use:** Every agent task execution in the cloud pipeline.
**Example:**
```typescript
// Source: Daytona SDK docs (https://www.daytona.io/docs/en/typescript-sdk/)
// src/cloud/daytona-client.ts
import { Daytona } from '@daytonaio/sdk';

export interface AgentTaskConfig {
  repoUrl: string;
  branch: string;
  envVars: Record<string, string>;
  command: string;
  timeoutSeconds?: number;
}

export async function executeAgentTask(config: AgentTaskConfig): Promise<{
  exitCode: number;
  stdout: string;
}> {
  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    target: process.env.DAYTONA_TARGET ?? 'us',
  });

  const sandbox = await daytona.create({
    language: 'typescript',
    envVars: config.envVars,
  });

  try {
    // Clone the target repo
    await sandbox.git.clone(
      config.repoUrl,
      '/home/daytona/workspace',
      config.branch,
    );

    // Execute the agent command
    const response = await sandbox.process.executeCommand(
      config.command,
      '/home/daytona/workspace',
      config.envVars,
      config.timeoutSeconds ?? 300,
    );

    return {
      exitCode: response.exitCode,
      stdout: response.result,
    };
  } finally {
    await sandbox.delete();
  }
}
```

### Pattern 3: S3 Artifact Round-Trip

**What:** Upload .planning/ directory to S3 before a task, download after task completion, verify integrity.
**When to use:** Every agent task to persist artifacts durably.
**Example:**
```typescript
// Source: AWS SDK v3 docs
// src/cloud/s3-artifacts.ts
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, relative } from 'path';

const s3 = new S3Client({ region: 'us-east-1' });

export async function uploadArtifact(
  bucket: string,
  runId: string,
  phase: string,
  localPath: string,
  fileName: string,
): Promise<void> {
  const key = `runs/${runId}/phases/${phase}/${fileName}`;
  const body = await readFile(localPath);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
  }));
}

export async function downloadArtifact(
  bucket: string,
  runId: string,
  phase: string,
  fileName: string,
  localPath: string,
): Promise<void> {
  const key = `runs/${runId}/phases/${phase}/${fileName}`;

  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  const body = await response.Body?.transformToByteArray();
  if (body) {
    await writeFile(localPath, body);
  }
}
```

### Pattern 4: Postgres Base Schema

**What:** Minimal schema for pipeline_runs and agent_runs tables.
**When to use:** Database initialization during CDK deploy or as a post-deploy script.
**Example:**
```sql
-- scripts/init-db-schema.sql
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  phase_current INTEGER NOT NULL DEFAULT 0,
  phase_total INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  phase INTEGER NOT NULL,
  plan_name TEXT NOT NULL,
  wave INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6) DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error_message TEXT,
  artifacts JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_runs_pipeline ON agent_runs(pipeline_run_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
```

### Anti-Patterns to Avoid

- **Hardcoded credentials in CDK or application code:** Always use Secrets Manager for database credentials and API keys. Never embed connection strings in source code. [VERIFIED: AWS security best practices docs]
- **NAT Gateway for dev environment:** At ~$32/month per NAT Gateway (plus data transfer), this is unnecessary when RDS is publicly accessible with SSL. Saves money for a dev-only environment. [ASSUMED]
- **Storing agent output in S3 as a single monolithic blob:** Use per-file keys matching the directory structure so individual files can be updated independently. [ASSUMED]
- **Creating Daytona sandboxes without auto-stop/auto-delete:** Sandboxes charge per-second. Always set `autoStopTimeout: 0` and explicitly delete in a `finally` block to prevent runaway costs. [CITED: https://www.daytona.io/docs/en/sandboxes/]
- **Using RDS multi-AZ or large instances for dev:** Wastes money. Single-AZ `db.t4g.micro` with no backup retention is appropriate for dev. [ASSUMED]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Database credential rotation | Custom rotation Lambda | `rds.Credentials.fromGeneratedSecret()` + Secrets Manager auto-rotation | CDK integrates credential generation with RDS directly; rotation is a single property [VERIFIED: CDK docs] |
| S3 multipart uploads | Manual chunk-and-reassemble | `@aws-sdk/lib-storage` Upload class | Handles chunking, retry, and progress tracking for large files [VERIFIED: npm registry] |
| VPC + subnet topology | Manual CloudFormation | CDK `ec2.Vpc` with `subnetConfiguration` | CDK handles route tables, internet gateways, NACLs automatically [VERIFIED: CDK docs] |
| SQS DLQ wiring | Manual redrive policy JSON | CDK `deadLetterQueue` property on Queue | CDK wires permissions, policies, and redrive config automatically [VERIFIED: CDK docs] |
| CDK stack testing | Custom assertion code | `aws-cdk-lib/assertions` Template matching | Built-in CDK assertion library for testing synthesized CloudFormation [VERIFIED: CDK docs] |
| SSL certificate for RDS | Self-signed cert management | AWS-managed RDS SSL certificate (rds-ca-rsa2048-g1) | RDS provides managed certificates; just enforce `sslmode=require` in connection string [VERIFIED: AWS RDS docs] |

**Key insight:** CDK's L2 constructs handle 90% of the configuration complexity for VPC, RDS, S3, and SQS. The remaining 10% is connecting Daytona to these resources via public internet with SSL -- which is a configuration concern, not a build concern.

## Common Pitfalls

### Pitfall 1: Daytona Sandbox Timeout Kills Long Agent Tasks
**What goes wrong:** Daytona auto-stop defaults to 15 minutes of inactivity. Agent SDK query() calls may have processing pauses that look like inactivity.
**Why it happens:** Daytona tracks keyboard/mouse/terminal activity, not CPU usage. Background processes and SDK calls don't reset the timer.
**How to avoid:** Disable auto-stop when creating sandboxes (`autoStopTimeout: 0`) and rely on explicit deletion in the `finally` block. Set a hard timeout on the executeCommand call instead.
**Warning signs:** Sandbox disappears mid-task; agent run shows "workspace not found" errors.
[CITED: https://www.daytona.io/docs/en/sandboxes/]

### Pitfall 2: RDS Connection from Daytona Without SSL
**What goes wrong:** Database credentials travel over public internet in cleartext, exposing them to interception.
**Why it happens:** Default `pg` connection does not enforce SSL. Must explicitly set `ssl: { rejectUnauthorized: true }` and download the RDS CA bundle.
**How to avoid:** Set RDS parameter `rds.force_ssl = 1` in the parameter group (enforces server-side). On the client, always connect with `sslmode=require` or `ssl: true` in the pg connection config.
**Warning signs:** Connections work without SSL configuration (means SSL is not being enforced).
[VERIFIED: AWS RDS security best practices docs]

### Pitfall 3: CDK Deploy Fails on First Run Without Bootstrap
**What goes wrong:** `cdk deploy` fails with "This stack uses assets, so the toolkit stack must be deployed" error.
**Why it happens:** CDK requires a one-time bootstrap (`cdk bootstrap`) to create the CDKToolkit stack with an S3 bucket and IAM roles for asset deployment.
**How to avoid:** Run `cdk bootstrap aws://{ACCOUNT_ID}/us-east-1` before the first deploy.
**Warning signs:** Error messages mentioning `CDKToolkit` stack or missing S3 bucket.
[VERIFIED: CDK docs]

### Pitfall 4: SQS Visibility Timeout Too Short for Agent Tasks
**What goes wrong:** Message becomes visible again while an agent is still processing, causing duplicate execution.
**Why it happens:** Default SQS visibility timeout is 30 seconds. Agent tasks can run for minutes.
**How to avoid:** Set visibility timeout to at least 6x the expected task duration. For agent tasks that may run 5-10 minutes, use 900 seconds (15 minutes). DLQ maxReceiveCount of 3 means a message gets 3 attempts before going to DLQ.
**Warning signs:** Same message processed by multiple consumers; duplicate agent runs in the database.
[CITED: AWS SQS developer guide]

### Pitfall 5: Daytona Sandbox Resource Limits
**What goes wrong:** Agent tasks fail with out-of-memory or CPU throttling during claude-agent-sdk query() calls.
**Why it happens:** Default Daytona sandbox is 1 vCPU / 1GB RAM. SDK operations plus Node.js plus git clone may exceed this.
**How to avoid:** Create sandboxes with custom resources: at least 2 vCPU / 4GB RAM. Organization max is 4 vCPU / 8GB RAM / 10GB disk.
**Warning signs:** OOM kills, slow response times, process crashes inside sandbox.
[CITED: https://www.daytona.io/docs/en/sandboxes/]

### Pitfall 6: S3 Artifact Integrity Not Verified
**What goes wrong:** Corrupted or truncated files after upload/download, silently causing agent failures.
**Why it happens:** Network issues during upload/download without checksum verification.
**How to avoid:** Use S3's built-in `ChecksumAlgorithm: 'SHA256'` on PutObject and verify `ChecksumSHA256` on GetObject. Or compute local SHA256 before upload and compare after download.
**Warning signs:** Files exist in S3 but have unexpected sizes; agent reads garbled data.
[ASSUMED]

## Code Examples

### CDK VPC with Public + Isolated Subnets (No NAT Gateway)

```typescript
// Source: CDK docs + verified CDK patterns
// infra/lib/constructs/networking.ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface CahNetworkingProps {
  prefix: string;
}

export class CahNetworking extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: CahNetworkingProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.prefix}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0, // No NAT gateway -- saves ~$32/month for dev
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
  }
}
```

### CDK RDS Postgres with Secrets Manager Credentials

```typescript
// Source: CDK docs + bobbyhadz.com verified patterns
// infra/lib/constructs/database.ts
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface CahDatabaseProps {
  prefix: string;
  vpc: ec2.Vpc;
}

export class CahDatabase extends Construct {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: cdk.aws_secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: CahDatabaseProps) {
    super(scope, id);

    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      parameters: {
        'rds.force_ssl': '1', // Enforce SSL connections
      },
    });

    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: `${props.prefix}-agent-db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC, // Publicly accessible for Daytona
      },
      credentials: rds.Credentials.fromGeneratedSecret('cah_admin'),
      databaseName: 'cah',
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      multiAz: false,
      backupRetention: cdk.Duration.days(1),
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      publiclyAccessible: true,
      parameterGroup,
      storageEncrypted: true,
    });

    // Allow connections from anywhere (Daytona Cloud IPs are dynamic)
    // SSL is enforced via parameter group
    this.instance.connections.allowFromAnyIpv4(ec2.Port.tcp(5432));

    this.secret = this.instance.secret!;

    // Output the secret ARN for retrieval
    new cdk.CfnOutput(scope, 'DbSecretArn', {
      value: this.secret.secretArn,
    });
  }
}
```

### CDK SQS Queue with Dead Letter Queue

```typescript
// Source: CDK docs + verified SQS patterns
// infra/lib/constructs/messaging.ts
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface CahMessagingProps {
  prefix: string;
}

export class CahMessaging extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: CahMessagingProps) {
    super(scope, id);

    this.dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${props.prefix}-jobs-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'JobQueue', {
      queueName: `${props.prefix}-jobs`,
      visibilityTimeout: cdk.Duration.seconds(900), // 15 min for agent tasks
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });
  }
}
```

### Postgres Client with SSL

```typescript
// Source: pg docs + AWS RDS SSL best practices
// src/cloud/postgres-client.ts
import { Pool, PoolConfig } from 'pg';

export function createDbPool(connectionString: string): Pool {
  const config: PoolConfig = {
    connectionString,
    ssl: {
      rejectUnauthorized: true, // Verify RDS certificate
    },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };

  return new Pool(config);
}

export interface PipelineRun {
  id: string;
  projectId: string;
  status: string;
  phaseCurrent: number;
  phaseTotal: number;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export async function insertPipelineRun(
  pool: Pool,
  projectId: string,
  phaseTotal: number,
  config: Record<string, unknown>,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO pipeline_runs (project_id, phase_total, config)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [projectId, phaseTotal, JSON.stringify(config)],
  );
  return result.rows[0].id;
}

export async function insertAgentRun(
  pool: Pool,
  pipelineRunId: string,
  phase: number,
  planName: string,
  wave: number,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO agent_runs (pipeline_run_id, phase, plan_name, wave, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING id`,
    [pipelineRunId, phase, planName, wave],
  );
  return result.rows[0].id;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| aws-cdk v1 (separate packages) | aws-cdk-lib v2 (monolithic) | 2022 | Single import, no version mismatches between constructs [VERIFIED: CDK docs] |
| AWS SDK v2 (monolithic) | AWS SDK v3 (modular clients) | 2021 | Tree-shakeable, smaller bundles, middleware stack [VERIFIED: npm registry] |
| Daytona self-hosted (Go binary) | Daytona Cloud + TypeScript SDK | 2025 | Cloud-hosted sandboxes via API, no self-hosting required [CITED: https://www.daytona.io/docs/en/] |
| CDK manual logical ID management | CDK Refactor (safe renames) | September 2025 | Stateful resources can be moved between constructs without replacement [CITED: CDK best practices 2026 article] |
| RDS password in Parameter Store | RDS Secrets Manager integration | 2022 | `fromGeneratedSecret()` handles creation + rotation natively [VERIFIED: CDK docs] |

**Deprecated/outdated:**
- `@aws-cdk/aws-*` v1 packages: Replaced by `aws-cdk-lib` v2. Do not use. [VERIFIED: CDK docs]
- `aws-sdk` v2 (monolithic): Replaced by `@aws-sdk/*` v3 modular clients. [VERIFIED: npm registry]
- `@daytona/sdk` (old package name): Now `@daytonaio/sdk`. The old name is a redirect. [VERIFIED: npm search, version 0.166.0 on @daytonaio/sdk]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | NAT Gateway costs ~$32/month and is unnecessary for dev environment with publicly accessible RDS | Anti-Patterns | If Daytona needs VPC-internal access (not just public internet), NAT would be needed; cost estimate may be off |
| A2 | db.t4g.micro is sufficient for dev workload (pipeline_runs + agent_runs tables) | Code Examples (Database) | If agent telemetry volume exceeds micro capacity, instance type needs upgrading |
| A3 | S3 PutObject with SHA256 checksum is sufficient for artifact integrity verification | Pitfalls | If network corruption is more common than expected, additional integrity mechanisms may be needed |
| A4 | Daytona sandbox with 2 vCPU / 4GB RAM is sufficient for agent SDK query() calls | Pitfalls | If agent tasks are memory-intensive, may need maximum 4 vCPU / 8GB RAM allocation |
| A5 | Per-file S3 keys matching directory structure is better than tar/zip uploads | Anti-Patterns | If there are thousands of small files, individual S3 puts may be slower than a single archive upload |
| A6 | RDS backup retention of 1 day is appropriate for dev | Code Examples (Database) | If debugging requires historical data, 0-day retention means no automated backups; 1 day is a compromise |
| A7 | Postgres `gen_random_uuid()` is available by default in Postgres 16 | Code Examples (Schema) | If the `pgcrypto` extension is not enabled by default, the schema creation will fail |
| A8 | 900-second SQS visibility timeout is sufficient for agent tasks | Code Examples (Messaging) | If tasks routinely exceed 15 minutes, messages will become visible and cause duplicate processing |

## Open Questions

1. **Daytona Sandbox Egress IPs for RDS Security Group**
   - What we know: Daytona Cloud sandboxes have internet access (Tier 3+) but no documented static egress IP ranges
   - What's unclear: Whether Daytona provides IP ranges for firewall whitelisting, or if 0.0.0.0/0 is the only option for security groups
   - Recommendation: Accept 0.0.0.0/0 on port 5432 with SSL enforcement for dev. Revisit with customer-managed compute or VPN tunnel if/when security requirements tighten for staging/prod

2. **Daytona Billing Tier Requirements**
   - What we know: Tier 3+ is needed for full internet access from sandboxes (required for RDS, S3, GitHub connectivity). Pricing is $0.00002/vCPU-second + $0.0000025/GB-RAM-second
   - What's unclear: Whether the $200 free tier credit is sufficient for Phase 1 validation, and what billing tier the account starts at
   - Recommendation: Verify Daytona account tier before implementation starts; budget ~$5-10 for Phase 1 validation (a few sandbox hours)

3. **AWS Quota Increases for Fresh Account**
   - What we know: STATE.md warns "AWS quota increases have 1-5 business day lead time"
   - What's unclear: Which specific quotas need increasing for Phase 1 (likely default RDS instance limits, VPC limits)
   - Recommendation: File quota increase requests on day one of implementation. Default quotas should be sufficient for a single dev environment, but verify: RDS instance count, VPC count, Elastic IP count

4. **gsd-tools.cjs Base Path Configurability**
   - What we know: STATE.md notes "gsd-tools.cjs base path configurability needs audit before Daytona workspace integration"
   - What's unclear: Whether gsd-tools.cjs hardcodes paths that won't work inside a Daytona sandbox
   - Recommendation: This is a Phase 2+ concern. Phase 1 validation (D-08) uses a simple SDK query task, not the full GSD pipeline. Defer the audit to when the full pipeline runs in Daytona

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | CDK, SDK, all runtime code | Yes | 22.18.0 | -- |
| npm | Package management | Yes | 10.9.3 | -- |
| Git | Version control, Daytona git clone | Yes | 2.39.5 | -- |
| CDK CLI (`cdk`) | Infrastructure deployment | Yes (npx) | 2.1118.0 | `npx aws-cdk` |
| AWS CLI | Manual verification, bootstrap | No | -- | CDK handles deployment; use SDK for programmatic access |
| Docker | Not required for Phase 1 | Yes | 29.2.1 | -- |
| TypeScript | CDK + SDK compilation | Yes | ^5.7.0 (in devDependencies) | -- |
| Vitest | Testing | Yes | 4.1.4 | -- |

**Missing dependencies with no fallback:**
- AWS CLI is not installed, but this is NOT blocking. CDK CLI (available via npx) handles all deployment. AWS SDK v3 handles all programmatic operations. AWS CLI is only needed for manual troubleshooting.

**Missing dependencies with fallback:**
- CDK CLI is not globally installed but available via `npx aws-cdk` (verified: 2.1118.0)

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 |
| Config file | `vitest.config.ts` (root) + CDK tests will need `infra/vitest.config.ts` or addition to root config |
| Quick run command | `npx vitest run --project unit` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | CDK synth produces CloudFormation with VPC, S3, RDS, SQS, IAM, Secrets Manager | unit | `npx vitest run infra/test/cah-stack.test.ts -x` | No -- Wave 0 |
| INFRA-02 | RDS Postgres instance accepts connections, base schema is queryable | integration | `npx vitest run src/cloud/test/postgres-client.integration.test.ts -x` | No -- Wave 0 |
| INFRA-03 | S3 artifacts round-trip (upload, download, verify identical) | integration | `npx vitest run src/cloud/test/s3-artifacts.integration.test.ts -x` | No -- Wave 0 |
| INFRA-04 | Daytona workspace create/execute/teardown lifecycle | integration | `npx vitest run src/cloud/test/daytona-client.integration.test.ts -x` | No -- Wave 0 |
| INFRA-05 | SQS queue accepts message, delivers to consumer, DLQ after max retries | integration | `npx vitest run src/cloud/test/sqs-consumer.integration.test.ts -x` | No -- Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run --project unit` (CDK assertion tests)
- **Per wave merge:** `npx vitest run` (full suite including integration if credentials available)
- **Phase gate:** Full suite green + manual validation script (`scripts/validate-phase1.ts`) before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `infra/test/cah-stack.test.ts` -- CDK assertion tests for INFRA-01 (synth + template matching)
- [ ] `src/cloud/test/postgres-client.test.ts` -- Unit tests for pg client (mocked)
- [ ] `src/cloud/test/s3-artifacts.test.ts` -- Unit tests for S3 operations (mocked)
- [ ] `src/cloud/test/daytona-client.test.ts` -- Unit tests for Daytona lifecycle (mocked)
- [ ] `src/cloud/test/sqs-consumer.test.ts` -- Unit tests for SQS consumer (mocked)
- [ ] `infra/package.json` + `infra/tsconfig.json` -- CDK project setup
- [ ] Root vitest config update to include `infra/test/` and `src/cloud/test/` test paths

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Secrets Manager for DB credentials + Daytona API key; IAM roles for AWS service access |
| V3 Session Management | No | No user sessions -- agent tasks are stateless |
| V4 Access Control | Yes | IAM least-privilege policies; Daytona sandbox-scoped credentials |
| V5 Input Validation | Yes | Validate SQS message schema before processing; parameterized SQL queries (pg `$1` placeholders) |
| V6 Cryptography | Yes | RDS SSL enforcement (`rds.force_ssl=1`); S3 SSE-S3 encryption at rest; Secrets Manager encryption |

### Known Threat Patterns for AWS + Daytona Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Database credential exposure in transit | Information Disclosure | SSL/TLS enforcement on RDS (`rds.force_ssl=1`), Secrets Manager rotation |
| SQL injection via SQS message content | Tampering | Parameterized queries (`$1` placeholders), input validation on message schema |
| Privilege escalation via overly broad IAM | Elevation of Privilege | Least-privilege IAM policies scoped to specific resources (bucket ARN, queue ARN) |
| Sandbox escape / lateral movement | Elevation of Privilege | Daytona isolation (container-level); credential scoping (task-specific env vars, no wildcard access) |
| Publicly accessible RDS exposure | Information Disclosure | SSL enforcement, strong passwords via Secrets Manager, security group restricted to port 5432 only |
| SQS message replay/duplicate processing | Tampering | Idempotency keys on agent runs (deferred to Phase 2 STATE-03, but design for it now) |
| Daytona API key compromise | Spoofing | Store in Secrets Manager, not in source code; rotate regularly |

## Sources

### Primary (HIGH confidence)
- npm registry -- verified all package versions (aws-cdk-lib 2.250.0, @daytonaio/sdk 0.166.0, @aws-sdk/* 3.1030.0, pg 8.20.0)
- CDK CLI -- verified version 2.1118.0 via `npx cdk --version`
- [AWS CDK Guide](https://github.com/awsdocs/aws-cdk-guide) via Context7 -- VPC, Secrets Manager, RDS patterns
- [Daytona TypeScript SDK Reference](https://www.daytona.io/docs/en/typescript-sdk/) -- SDK API, sandbox lifecycle
- [Daytona Sandbox Documentation](https://www.daytona.io/docs/en/sandboxes/) -- lifecycle states, resource limits, auto-stop
- [Daytona Process/Code Execution](https://www.daytona.io/docs/en/process-code-execution/) -- executeCommand, codeRun patterns
- [Daytona Git Operations](https://www.daytona.io/docs/en/git-operations/) -- clone, status, commit, push from sandbox
- [AWS RDS Security Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.Security.html) -- SSL, encryption, credential management

### Secondary (MEDIUM confidence)
- [bobbyhadz.com CDK RDS Example](https://bobbyhadz.com/blog/aws-cdk-rds-example) -- Complete TypeScript CDK stack with VPC + RDS + Secrets Manager
- [CDK Best Practices 2026](https://dev.to/dannysteenman/aws-cdk-best-practices-the-complete-guide-2026-2nhg) -- CDK Refactor, construct composition, compliance
- [Daytona Pricing](https://www.daytona.io/pricing) -- Per-second billing rates, free tier
- [Daytona Network Limits](https://www.daytona.io/docs/en/network-limits/) -- Firewall rules, egress restrictions, tier requirements

### Tertiary (LOW confidence)
- Daytona customer-managed compute status (experimental) -- based on multiple blog comparisons, not verified with Daytona directly
- NAT Gateway monthly cost estimate (~$32/month) -- based on training data pricing, actual price may differ

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all versions verified against npm registry; CDK patterns confirmed via official docs
- Architecture: HIGH -- Daytona SDK API verified via official docs; CDK patterns verified via Context7 + official guides
- Pitfalls: MEDIUM -- auto-stop behavior verified via Daytona docs; some cost estimates and resource sizing are assumed
- Daytona-to-RDS connectivity: MEDIUM -- public RDS approach is well-documented for AWS; Daytona-specific egress behavior less documented

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (stable AWS/CDK ecosystem; Daytona SDK is fast-moving, re-verify if version > 0.170)

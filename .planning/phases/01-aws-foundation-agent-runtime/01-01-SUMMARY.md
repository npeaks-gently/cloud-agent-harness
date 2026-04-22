---
phase: 01-aws-foundation-agent-runtime
plan: 01
subsystem: infra
tags: [cdk, aws, vpc, s3, rds, sqs, iam, infrastructure]
dependency_graph:
  requires: []
  provides:
    - infra/lib/cah-stack.ts
    - infra/lib/constructs/networking.ts
    - infra/lib/constructs/storage.ts
    - infra/lib/constructs/database.ts
    - infra/lib/constructs/messaging.ts
    - infra/lib/constructs/iam.ts
  affects:
    - infra/
tech_stack:
  added:
    - aws-cdk-lib@^2.250.0
    - constructs@^10.6.0
    - tsx@^4.21.0
    - vitest@^4.1.2
  patterns:
    - CDK L2 constructs with Props interfaces
    - Single-stack composition pattern
    - Least-privilege IAM with resource-scoped ARNs
key_files:
  created:
    - infra/package.json
    - infra/tsconfig.json
    - infra/cdk.json
    - infra/bin/cah.ts
    - infra/lib/cah-stack.ts
    - infra/lib/constructs/networking.ts
    - infra/lib/constructs/storage.ts
    - infra/lib/constructs/database.ts
    - infra/lib/constructs/messaging.ts
    - infra/lib/constructs/iam.ts
    - infra/test/cah-stack.test.ts
    - infra/vitest.config.ts
    - infra/.gitignore
  modified: []
decisions:
  - Used tsx instead of ts-node for CDK app execution (ts-node ESM resolution broken with .js extensions)
  - IAM user with access key stored in Secrets Manager (Daytona uses access keys, not IAM roles)
  - RDS in public subnet with SSL enforcement for Daytona connectivity (no VPC peering available)
metrics:
  duration_seconds: 309
  completed: "2026-04-16T01:44:00Z"
  tasks_completed: 2
  tasks_total: 2
  test_count: 27
  test_pass: 27
  lines_of_code: 804
---

# Phase 1 Plan 1: AWS CDK Infrastructure Stack Summary

Single CDK stack provisioning VPC (no NAT), S3 with SSE-S3, RDS Postgres 16 with SSL enforcement and Secrets Manager credentials, SQS with DLQ, and least-privilege IAM for Daytona agent access -- all resources using cah-dev-* naming convention.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | CDK project scaffolding and all infrastructure constructs | e41af47 | infra/lib/cah-stack.ts, infra/lib/constructs/*.ts, infra/bin/cah.ts |
| 2 | CDK assertion tests for all constructs | 87b10a2 | infra/test/cah-stack.test.ts, infra/vitest.config.ts |

## What Was Built

### CDK Project Structure (infra/)
- **package.json**: CDK project with aws-cdk-lib ^2.250.0, constructs ^10.6.0, vitest, tsx
- **tsconfig.json**: Strict TypeScript, ES2022 target, NodeNext module resolution
- **cdk.json**: CDK app entry via `npx tsx bin/cah.ts`
- **bin/cah.ts**: App entry point creating CahStack in us-east-1

### Infrastructure Constructs
- **CahNetworking**: VPC 10.0.0.0/16, 2 AZs, public + isolated subnets, 0 NAT gateways
- **CahStorage**: S3 bucket `cah-dev-pipeline-bucket`, SSE-S3, BlockPublicAccess.BLOCK_ALL, DESTROY removal
- **CahDatabase**: RDS Postgres 16 `cah-dev-agent-db`, db.t4g.micro, publicly accessible, SSL enforced via `rds.force_ssl=1`, Secrets Manager credentials, 20-50GB auto-scaling storage
- **CahMessaging**: SQS `cah-dev-jobs` (900s visibility timeout, 4-day retention), DLQ `cah-dev-jobs-dlq` (14-day retention, maxReceiveCount 3)
- **CahIam**: IAM user `cah-dev-agent` with managed policy scoped to specific S3 bucket, SQS queue, and Secrets Manager secret ARNs (no wildcard resources); access key stored in `cah-dev/agent-credentials` secret

### Stack Outputs
BucketName, DbEndpoint, QueueUrl, SecretArn -- all exported as CfnOutputs

### Test Coverage
27 CDK assertion tests covering:
- VPC CIDR, no NAT, public subnets
- S3 BlockPublicAccess (all 4 flags), SSE-S3, bucket name
- RDS Postgres engine, db.t4g.micro, public accessibility, SSL enforcement, storage encryption
- Secrets Manager secrets (RDS + agent credentials)
- SQS visibility timeout (900s), DLQ retention, maxReceiveCount
- IAM policy statements (S3, SQS, SecretsManager), no wildcard resources
- Stack outputs (BucketName, DbEndpoint, QueueUrl, SecretArn)
- Stack synthesis and resource count

## Verification Results

1. `npx tsc --noEmit` -- PASSED (TypeScript compiles without errors)
2. `npx vitest run test/cah-stack.test.ts` -- PASSED (27/27 tests pass)
3. `npx aws-cdk synth --quiet` -- PASSED (CloudFormation template generated)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] CDK synth fails with ts-node ESM resolution**
- **Found during:** Task 2 verification
- **Issue:** `ts-node --esm` cannot resolve `.js` extension imports to `.ts` files in Node.js >=22. CDK synth fails with ERR_MODULE_NOT_FOUND.
- **Fix:** Replaced `npx ts-node --esm bin/cah.ts` with `npx tsx bin/cah.ts` in cdk.json. Added tsx as devDependency. tsx handles ESM TypeScript natively without configuration.
- **Files modified:** infra/cdk.json, infra/package.json
- **Commit:** 87b10a2

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| tsx over ts-node for CDK | ts-node ESM resolution is broken with .js extensions on Node.js >=22; tsx handles this natively |
| IAM user with access key | Daytona Cloud uses access keys injected as env vars, not IAM roles (no instance profiles in sandboxes) |
| Agent credentials in Secrets Manager | Access key stored as `cah-dev/agent-credentials` secret, not hardcoded (T-01-07 mitigation) |
| RDS in public subnet | Daytona Cloud has no VPC peering; publicly accessible RDS with SSL is the pragmatic dev approach |

## Threat Mitigations Applied

| Threat ID | Mitigation | Implementation |
|-----------|------------|----------------|
| T-01-01 | SSL enforcement on RDS | Parameter group with `rds.force_ssl=1`; security group port 5432 only |
| T-01-02 | Least-privilege IAM | Policy scoped to specific bucket, queue, and secret ARNs; no wildcard resources |
| T-01-03 | Strong RDS credentials | `fromGeneratedSecret('cah_admin')` auto-generates password in Secrets Manager |
| T-01-04 | S3 tamper protection | `BlockPublicAccess.BLOCK_ALL`, SSE-S3 encryption, IAM-only access |
| T-01-05 | S3 data encryption | SSE-S3 server-side encryption at rest |
| T-01-07 | Secure agent credentials | Access key stored in Secrets Manager secret `cah-dev/agent-credentials` |

## Self-Check: PASSED

- All 14 files verified present on disk
- Both task commits (e41af47, 87b10a2) verified in git log
- TypeScript compilation verified (exit 0)
- All 27 CDK assertion tests pass
- CDK synth produces valid CloudFormation template

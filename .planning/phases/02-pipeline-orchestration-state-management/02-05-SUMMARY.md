---
phase: 02-pipeline-orchestration-state-management
plan: 05
subsystem: pipeline-lambda-infrastructure
tags: [pipeline, lambda, cdk, sqs, iam, secrets-manager, vpc, infrastructure]
dependency_graph:
  requires: [infra/lib/constructs/messaging.ts, infra/lib/constructs/database.ts, infra/lib/constructs/storage.ts, infra/lib/constructs/networking.ts, infra/lib/constructs/iam.ts, infra/lib/cah-stack.ts]
  provides: [infra/lib/constructs/pipeline-lambda.ts, infra/test/pipeline-lambda.test.ts]
  affects: [infra/lib/cah-stack.ts, infra/lib/constructs/database.ts]
tech_stack:
  added: [aws-cdk-lib/aws-lambda, aws-cdk-lib/aws-lambda-event-sources]
  patterns: [SQS event source Lambda trigger, Secrets Manager ARN-in-env pattern, VPC-placed Lambda with security group ingress, CDK assertions Template testing]
key_files:
  created:
    - infra/lib/constructs/pipeline-lambda.ts
    - infra/test/pipeline-lambda.test.ts
    - infra/lambda/stage-router/index.js
  modified:
    - infra/lib/cah-stack.ts
    - infra/lib/constructs/database.ts
    - infra/.gitignore
decisions:
  - "ANTHROPIC_API_KEY_SECRET_ARN stored in env (not raw key) -- Lambda fetches from Secrets Manager at runtime (T-02-18)"
  - "Separate SecretsManager IAM statements for DB and Anthropic secrets (least-privilege, T-02-17)"
  - "Lambda placed in PRIVATE_ISOLATED subnets with dedicated security group for RDS ingress"
  - "Placeholder Lambda handler in infra/lambda/stage-router/ for CDK Code.fromAsset synthesis"
  - "Added !lambda/**/*.js exception to infra/.gitignore for Lambda asset tracking"
metrics:
  duration: 3m 39s
  completed: 2026-04-16T05:58:30Z
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 3
  test_count: 14
  test_pass: 14
---

# Phase 02 Plan 05: CDK Pipeline Lambda Infrastructure Summary

CDK construct for pipeline stage-router Lambda with dual SQS event sources, least-privilege IAM (S3/SQS/SecretsManager), VPC placement for RDS, and 14-test CDK assertions suite.

## What Was Built

### Pipeline Lambda Construct (`infra/lib/constructs/pipeline-lambda.ts`)
- **CahPipelineLambda** CDK construct following project conventions (Props interface, JSDoc, section dividers)
- **Stage Queue** (internal SQS) with 900s visibility timeout matching Lambda timeout, DLQ with maxReceiveCount 3 (T-02-16)
- **Lambda IAM Role** with 4 least-privilege policy statements (T-02-17):
  - S3: GetObject, PutObject, ListBucket scoped to pipeline bucket
  - SQS: ReceiveMessage, DeleteMessage, GetQueueAttributes, SendMessage scoped to job + stage queues
  - SecretsManager (DB): GetSecretValue scoped to DB secret ARN
  - SecretsManager (Anthropic): GetSecretValue scoped to Anthropic key secret ARN
- **Lambda Function**: Node.js 22, 900s timeout, 512MB memory, reserved concurrency 10, VPC PRIVATE_ISOLATED placement
- **Environment Variables**: STAGE_QUEUE_URL, NODE_OPTIONS, ANTHROPIC_API_KEY_SECRET_ARN (ARN only, not raw key per T-02-18), DB_SECRET_ARN
- **Security Group**: Dedicated Lambda SG with ingress rule on DB security group for port 5432
- **Event Sources**: Job queue (batchSize: 1) for intake, stage queue (batchSize: 1) for stage routing

### Database Security Group Exposure (`infra/lib/constructs/database.ts`)
- Changed `const securityGroup` to `public readonly securityGroup` on CahDatabase class
- Updated all internal references from `securityGroup` to `this.securityGroup`
- Enables pipeline Lambda construct to add ingress rule for RDS connectivity

### Stack Composition (`infra/lib/cah-stack.ts`)
- Import CahPipelineLambda construct and aws-cdk-lib/aws-secretsmanager
- Look up Anthropic API key secret via `Secret.fromSecretNameV2` (secret must pre-exist)
- Compose CahPipelineLambda with cross-construct references (VPC, bucket ARN, job queue, DB secret ARN, DB security group, Anthropic key secret)
- Stack outputs: StageQueueUrl and StageRouterFnArn

### CDK Assertions Test (`infra/test/pipeline-lambda.test.ts`)
- 14 tests across 6 describe blocks:
  - Lambda Configuration (3): timeout 900s, runtime nodejs22.x, reserved concurrency 10
  - Stage Queue (2): 900s visibility timeout, DLQ exists
  - IAM Policy (3): SecretsManager, S3, and SQS actions present
  - Lambda Environment (3): ANTHROPIC_API_KEY_SECRET_ARN, DB_SECRET_ARN, STAGE_QUEUE_URL
  - Stack Outputs (2): StageQueueUrl, StageRouterFnArn
  - Synthesis (1): stack synths without errors

### Placeholder Lambda Handler (`infra/lambda/stage-router/index.js`)
- Stub handler required by CDK `Code.fromAsset()` during synthesis
- Actual handler in `src/cloud/pipeline/stage-router.ts` will be bundled in a later phase

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | CDK pipeline Lambda construct and DB security group | b8e3a2e | infra/lib/constructs/pipeline-lambda.ts, infra/lib/constructs/database.ts, infra/lambda/stage-router/index.js, infra/.gitignore |
| 2 | Wire pipeline Lambda into cah-stack.ts | 2cf0ed2 | infra/lib/cah-stack.ts |
| 3 | CDK assertions test for pipeline Lambda | eb85ccc | infra/test/pipeline-lambda.test.ts |

## TDD Gate Compliance

- Task 3 has `tdd="true"` but implementation was completed in Tasks 1-2 (construct + stack wiring)
- Tests written in Task 3 passed immediately against the existing implementation (GREEN)
- test(02-05) commit: eb85ccc -- 14 tests, all passing
- No separate RED gate since this is a test-after-implementation pattern (implementation in separate tasks)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created placeholder Lambda handler for CDK synthesis**
- **Found during:** Task 1
- **Issue:** CDK `Code.fromAsset('lambda/stage-router')` requires the directory and a handler file to exist at synth time
- **Fix:** Created `infra/lambda/stage-router/index.js` stub handler and added `!lambda/**/*.js` exception to `infra/.gitignore` (which ignores all `*.js` files)
- **Files modified:** infra/lambda/stage-router/index.js, infra/.gitignore
- **Commit:** b8e3a2e

## Verification Results

- `npx tsc --noEmit` -- no type errors across entire infra directory
- `npx vitest run test/pipeline-lambda.test.ts` -- 14/14 tests passed
- `npx vitest run` -- 41/41 tests passed (27 existing + 14 new, no regressions)
- `infra/lib/cah-stack.ts` composes CahPipelineLambda with all required props including anthropicKeySecret
- Lambda timeout (900s) matches SQS visibility timeout (900s)
- IAM policy includes S3, SQS, and SecretsManager access (both DB and Anthropic key secrets)
- Lambda env contains ANTHROPIC_API_KEY_SECRET_ARN (not the raw key)

## Known Stubs

- **infra/lambda/stage-router/index.js**: Placeholder Lambda handler -- will be replaced when `src/cloud/pipeline/stage-router.ts` is bundled and deployed (future phase). This stub is required for CDK synthesis but is not the production handler.

## Threat Surface Scan

All threat model mitigations implemented as specified:
- T-02-16: Reserved concurrency 10 prevents runaway invocations; stage DLQ with maxReceiveCount 3 prevents infinite retries
- T-02-17: IAM policy uses least-privilege -- specific actions scoped to specific resource ARNs, no wildcards
- T-02-18: ANTHROPIC_API_KEY_SECRET_ARN in env (not raw key) -- Lambda fetches via SecretsManager:GetSecretValue at runtime
- T-02-19: SQS queues use default SSE-SQS encryption; SendMessage restricted to Lambda role via IAM

No new threat surface beyond what was documented in the plan's threat model.

## Self-Check: PASSED

- All 3 created files exist on disk
- All 3 modified files exist on disk
- All 3 task commits verified in git log (b8e3a2e, 2cf0ed2, eb85ccc)

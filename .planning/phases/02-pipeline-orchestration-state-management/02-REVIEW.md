---
phase: 02-pipeline-orchestration-state-management
reviewed: 2026-04-16T06:02:18Z
depth: standard
files_reviewed: 28
files_reviewed_list:
  - infra/lib/cah-stack.ts
  - infra/lib/constructs/database.ts
  - infra/lib/constructs/pipeline-lambda.ts
  - infra/test/pipeline-lambda.test.ts
  - scripts/migrate-002-idempotency.sql
  - src/cloud/entrypoint/agent-entrypoint.ts
  - src/cloud/entrypoint/s3-sync.ts
  - src/cloud/entrypoint/sdk-loader.ts
  - src/cloud/pipeline/checkpoint.ts
  - src/cloud/pipeline/idempotency.ts
  - src/cloud/pipeline/resume.ts
  - src/cloud/pipeline/sandbox-task.ts
  - src/cloud/pipeline/stage-router.ts
  - src/cloud/pipeline/stages/approve.ts
  - src/cloud/pipeline/stages/execute.ts
  - src/cloud/pipeline/stages/intake.ts
  - src/cloud/pipeline/stages/plan.ts
  - src/cloud/pipeline/stages/pr.ts
  - src/cloud/pipeline/stages/research.ts
  - src/cloud/pipeline/stages/verify.ts
  - src/cloud/pipeline/types.ts
  - src/cloud/snapshot/image-builder.ts
  - src/cloud/snapshot/snapshot-manager.ts
  - src/cloud/test/checkpoint.test.ts
  - src/cloud/test/entrypoint.test.ts
  - src/cloud/test/idempotency.test.ts
  - src/cloud/test/resume.test.ts
  - src/cloud/test/s3-sync.test.ts
  - src/cloud/test/stage-router.test.ts
findings:
  critical: 2
  warning: 5
  info: 4
  total: 11
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-04-16T06:02:18Z
**Depth:** standard
**Files Reviewed:** 28
**Status:** issues_found

## Summary

This phase introduces the full pipeline orchestration layer: SQS-driven stage routing, Postgres-backed checkpointing, idempotent task upserts, Daytona sandbox task execution, S3 context sync, and the agent entrypoint. The architecture is well-structured and follows the project conventions closely. Test coverage is solid across all major paths.

Two critical issues were found: the Anthropic API key is passed in plaintext into sandbox environment variables (negating the security design stated in T-02-18), and the S3 download loop lacks pagination — pipelines with more than 1,000 planning files will silently lose data. Five warnings address logic gaps that can cause silent failures or data loss in production: unhandled `executeTask` failures not writing checkpoints on partial errors, unsafe unsafe-cast that silently defaults `planCount`, missing error propagation from upstream stage failures to the pipeline DB record, and two gaps in the ListObjectsV2 usage. Four informational items cover dead code, magic number hardcoding, and a minor test assertion gap.

## Critical Issues

### CR-01: Anthropic API key passed as plaintext env var into Daytona sandbox

**File:** `src/cloud/pipeline/sandbox-task.ts:98`
**Issue:** `ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? ''` injects the key as a plaintext environment variable into every sandbox. The Lambda's own env var `ANTHROPIC_API_KEY` is never set (the construct only provides `ANTHROPIC_API_KEY_SECRET_ARN`), so this always injects an empty string into sandboxes. The design intent (T-02-18, pipeline-lambda.ts comment) is to fetch the key from Secrets Manager at cold start — but there is no fetch call anywhere in the Lambda handler path. The sandbox will always have an empty `ANTHROPIC_API_KEY` and the SDK calls will fail with auth errors.

**Fix:** Fetch the key from Secrets Manager at Lambda cold start and cache it in module scope, then inject the resolved value:

```typescript
// At module top-level (cold-start cache)
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let cachedApiKey: string | undefined;

async function getAnthropicApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.ANTHROPIC_API_KEY_SECRET_ARN;
  if (!secretArn) throw new Error('ANTHROPIC_API_KEY_SECRET_ARN not set');
  const client = new SecretsManagerClient({ region: 'us-east-1' });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  cachedApiKey = response.SecretString ?? '';
  return cachedApiKey;
}

// In runAgentTask(), before building agentConfig:
const anthropicApiKey = await getAnthropicApiKey();
// ...
envVars: {
  // ...
  ANTHROPIC_API_KEY: anthropicApiKey,
},
```

---

### CR-02: S3 listing in downloadPlanningDir is not paginated

**File:** `src/cloud/entrypoint/s3-sync.ts:47-51`
**Issue:** `ListObjectsV2Command` returns at most 1,000 keys per call. The code uses the first page only and returns without following `NextContinuationToken`. For pipelines with more than 1,000 planning files (e.g., large multi-phase runs), files beyond the first page are silently skipped — the agent proceeds with an incomplete context and produces incorrect output with no error or warning.

**Fix:** Loop until `IsTruncated` is false:

```typescript
let continuationToken: string | undefined;
let count = 0;

do {
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }),
  );

  for (const obj of response.Contents ?? []) {
    // ... existing download logic
    count++;
  }

  continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
} while (continuationToken);

return count;
```

---

## Warnings

### WR-01: Failed stage does not mark pipeline_runs as failed in Postgres

**File:** `src/cloud/pipeline/stage-router.ts:207-213`
**Issue:** When a stage handler returns `status: 'failed'`, `routeStage` correctly skips sending the next SQS message. However, it still calls `updatePipelineStage(pool, runId, nextStage)` with the *next* stage value (e.g., `PipelineStage.Plan` after research fails). The pipeline_runs row is updated to reflect the next stage with `status = 'running'` instead of `status = 'failed'`. This means a crashed pipeline appears "in progress" in the database indefinitely, making resume logic and observability incorrect.

**Fix:** Check the result status before updating pipeline state:

```typescript
// Step 4: Update pipeline stage in Postgres
if (result.status === 'failed') {
  // Mark the pipeline itself as failed, not advanced
  const failSql = `UPDATE pipeline_runs SET status = 'failed', current_stage = $1 WHERE id = $2`;
  await pool.query(failSql, [msg.stage, msg.runId]);
} else {
  const nextStage = NEXT_STAGE[msg.stage];
  await updatePipelineStage(pool, msg.runId, nextStage);

  // Step 5: Send next-stage SQS message (if not terminal)
  if (nextStage !== null) {
    // ... existing SQS send logic
  }
}
```

---

### WR-02: planCount cast silently defaults to 1 on type mismatch

**File:** `src/cloud/pipeline/stages/execute.ts:52`
**Issue:** `const planCount = (msg.context as Record<string, unknown>).planCount as number ?? 1;` casts `context` to a loose record type to extract `planCount`. If the planner stage sets `planCount` as a string (e.g., `"3"` from JSON deserialization), the `as number` cast succeeds at compile time but the value is a string at runtime. The `??` only guards against `undefined`/`null`, not a non-numeric string. The `for` loop condition `plan <= planCount` would then do string comparison, evaluating incorrectly (`1 <= "3"` is `true` in JS but the loop semantics break for multi-digit counts).

Additionally, this pattern bypasses TypeScript's strict typing. The planner stage should set a properly-typed field in the context, or the execute stage should validate and coerce:

```typescript
const rawPlanCount = (msg.context as Record<string, unknown>).planCount;
const planCount = typeof rawPlanCount === 'number' && rawPlanCount > 0
  ? rawPlanCount
  : 1;
```

---

### WR-03: writeAgentCheckpoint does not write checkpoint when executeTask itself throws

**File:** `src/cloud/pipeline/sandbox-task.ts:140-167`
**Issue:** The catch block in `runAgentTask` calls `writeAgentCheckpoint` for the failure case. However, if `writeAgentCheckpoint` itself throws a `PipelineError` (e.g., DB is down), the outer catch rethrows it at line 143 — which is correct. The gap is subtler: if `client.executeTask(agentConfig)` throws and `writeAgentCheckpoint` also fails (both DB and sandbox down), the catch rethrows the checkpoint error masking the original `executeTask` error. The caller only sees a DB error, losing the original failure context.

**Fix:** Log the original error before attempting the checkpoint write, and avoid masking:

```typescript
} catch (err) {
  if (err instanceof PipelineError) throw err;

  const message = err instanceof Error ? err.message : String(err);
  const failOutcome: AgentTaskOutcome = { /* ... */ };

  // Attempt checkpoint but don't let it mask the original error
  try {
    await writeAgentCheckpoint(pool, taskKey, { ...agentRunData, status: 'failed' }, failOutcome);
  } catch (checkpointErr) {
    console.error(JSON.stringify({
      level: 'warn',
      message: 'Failed to write failure checkpoint',
      originalError: message,
      checkpointError: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
    }));
  }

  throw new PipelineError(`Agent task failed: ${message}`, 'runAgentTask', config.msg.stage);
}
```

---

### WR-04: git diff command misses untracked new files created by agent

**File:** `src/cloud/entrypoint/agent-entrypoint.ts:61`
**Issue:** `git diff --name-only HEAD` reports modified tracked files but does not include untracked new files. If the agent creates a new file (e.g., a new planning artifact, a new source file), that file is completely missed and not uploaded to S3. The pipeline orchestrator then has an incomplete artifact set and downstream stages work with missing context.

**Fix:** Use `git status --porcelain` to capture both modified and untracked files:

```typescript
const output = execSync('git status --porcelain', {
  cwd: workDir,
  encoding: 'buffer',
});

const filePaths = output
  .toString('utf-8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => line.replace(/^[?! MADRCU]{2}\s+/, '')); // strip status prefix
```

---

### WR-05: S3 download skips objects when Body is absent but still increments nothing — count is correct but mkdir was already called

**File:** `src/cloud/entrypoint/s3-sync.ts:64-73`
**Issue:** When `getResponse.Body` is null/undefined (line 68: `if (!getResponse.Body) continue`), the loop skips writing the file but has already called `mkdir(dirname(fullPath), { recursive: true })` at line 62. An empty directory is created on the filesystem for a file that was never written. While not a crash, this leaves phantom directories that could confuse downstream file-existence checks and is a resource leak in the sandbox filesystem.

**Fix:** Move the `mkdir` call after verifying the Body is present:

```typescript
const getResponse = await s3.send(
  new GetObjectCommand({ Bucket: bucket, Key: key }),
);

if (!getResponse.Body) continue;

// Only create directories when we know we'll write the file
await mkdir(dirname(fullPath), { recursive: true });
const bytes = await getResponse.Body.transformToByteArray();
await writeFile(fullPath, Buffer.from(bytes));
count++;
```

---

## Info

### IN-01: Lambda placed in PRIVATE_ISOLATED subnet has no NAT gateway for Secrets Manager / SQS access

**File:** `infra/lib/constructs/pipeline-lambda.ts:175`
**Issue:** The Lambda is placed in `SubnetType.PRIVATE_ISOLATED` subnets. The stack comment states "VPC with public + isolated subnets, no NAT." PRIVATE_ISOLATED subnets have no internet access and no NAT. However, the Lambda needs to call Secrets Manager, SQS, and S3 — all AWS APIs. Without VPC Interface Endpoints for these services, the Lambda will fail to connect. This may be intentional if VPC endpoints are created elsewhere (e.g., in the networking construct), but they are not visible in the reviewed files. If endpoints are missing, all Lambda invocations fail at cold start.

**Fix:** Verify that `CahNetworking` creates VPC Interface Endpoints for `secretsmanager`, `sqs`, and `s3` (Gateway endpoint for S3). If not, either add them to the networking construct or move Lambda to a subnet with NAT access.

---

### IN-02: Database RemovalPolicy.DESTROY and deletionProtection: false in production-adjacent config

**File:** `infra/lib/constructs/database.ts:98-99`
**Issue:** `removalPolicy: cdk.RemovalPolicy.DESTROY` and `deletionProtection: false` mean a `cdk destroy` call will permanently delete the RDS instance and all pipeline state. The stack is labeled `cah-dev` (PREFIX = 'cah-dev') suggesting this is intentional for dev, but these settings exist in the same CDK code that could be promoted to prod without a flag-gated override.

**Fix:** Gate these properties behind an environment parameter to prevent accidental production data loss:

```typescript
removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
deletionProtection: props.isProd,
```

---

### IN-03: Hardcoded region string in multiple files

**File:** `src/cloud/entrypoint/agent-entrypoint.ts:29`, `src/cloud/entrypoint/s3-sync.ts:23`, `src/cloud/pipeline/stage-router.ts:39`
**Issue:** `const DEFAULT_REGION = 'us-east-1'` is duplicated across three files with no shared constant. If the deployment region changes, all three must be updated manually and the S3Client in the sandbox will be misconfigured.

**Fix:** Define once in a shared `constants.ts` and import, or read from `AWS_DEFAULT_REGION` env var (set automatically by Lambda):

```typescript
const DEFAULT_REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
```

---

### IN-04: Test for entrypoint does not verify that costUsd reflects SDK result

**File:** `src/cloud/test/entrypoint.test.ts:272-278`
**Issue:** The JSON result output test asserts `output.costUsd` exists but does not assert its value. `mockExecutePlan` returns `{ success: true, totalCostUsd: 1.25, ... }` but the entrypoint maps `result.totalCostUsd ?? 0` to `costUsd`. The test does not verify this mapping, so a future rename of `totalCostUsd` in the SDK would silently regress to `costUsd: 0` without a failing test.

**Fix:** Add a value assertion:

```typescript
expect(output).toHaveProperty('costUsd', 1.25); // mapped from totalCostUsd
```

---

_Reviewed: 2026-04-16T06:02:18Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

---
phase: 03-integrations
reviewed: 2026-04-16T18:50:53Z
depth: standard
files_reviewed: 28
files_reviewed_list:
  - infra/lambda/slack-webhook/index.js
  - infra/lib/cah-stack.ts
  - infra/lib/constructs/slack-webhook.ts
  - scripts/migrate-003-approvals.sql
  - src/cloud/analytics.ts
  - src/cloud/entrypoint/agent-entrypoint.ts
  - src/cloud/integrations/github.ts
  - src/cloud/integrations/linear.ts
  - src/cloud/integrations/slack.ts
  - src/cloud/pipeline/merge-executor.ts
  - src/cloud/pipeline/stage-router.ts
  - src/cloud/pipeline/stages/approve.ts
  - src/cloud/pipeline/stages/intake.ts
  - src/cloud/pipeline/stages/pr.ts
  - src/cloud/pipeline/types.ts
  - src/cloud/postgres-client.ts
  - src/cloud/test/analytics.test.ts
  - src/cloud/test/approve.test.ts
  - src/cloud/test/entrypoint.test.ts
  - src/cloud/test/github-client.test.ts
  - src/cloud/test/intake-intg.test.ts
  - src/cloud/test/linear-client.test.ts
  - src/cloud/test/merge-executor.test.ts
  - src/cloud/test/pr.test.ts
  - src/cloud/test/slack-client.test.ts
  - src/cloud/test/slack-webhook.test.ts
  - src/cloud/test/stage-router.test.ts
  - src/cloud/webhook/slack-handler.ts
findings:
  critical: 3
  warning: 4
  info: 4
  total: 11
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-16T18:50:53Z
**Depth:** standard
**Files Reviewed:** 28
**Status:** issues_found

## Summary

Reviewed all 28 source files for the Phase 03 integrations: Slack webhook, GitHub branch/PR management, Linear ticket lifecycle, PostHog analytics, and the pipeline stage orchestration that wires them together. The overall architecture is clean and well-tested. The Slack HMAC-SHA256 verification, UUID approval tokens, parameterized SQL, and Secrets Manager caching all follow sound patterns.

Three critical issues require fixes before this code handles real traffic: a `timingSafeEqual` panic when incoming Slack signatures have an unexpected length, a shell injection vector in the git commit message, and a silent SSL downgrade in the Postgres pool factory when the RDS CA cert is absent at runtime. Four warnings cover logic gaps that can cause subtle failures under concurrent or misconfigured conditions.

---

## Critical Issues

### CR-01: `timingSafeEqual` panics on length-mismatched signatures

**File:** `src/cloud/webhook/slack-handler.ts:86-92`
**Issue:** `timingSafeEqual` requires both `Buffer` arguments to have identical byte lengths and throws `TypeError: Input buffers must have the same byte length` when they differ. The computed HMAC signature is always 71 bytes (`v0=` + 64 hex chars). An attacker (or malformed Slack retry) that sends any `x-slack-signature` of a different length causes the Lambda to crash with an unhandled exception rather than return 401. This bypasses the generic-error-response requirement in T-03-24 and causes 500 responses observable by the caller.

**Fix:**
```typescript
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const fiveMinutes = 5 * 60;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) {
    return false;
  }
  const sigBaseString = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${createHmac('sha256', signingSecret)
    .update(sigBaseString)
    .digest('hex')}`;
  const a = Buffer.from(mySignature);
  const b = Buffer.from(signature);
  // timingSafeEqual requires identical lengths; unequal length is an immediate mismatch
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

---

### CR-02: Shell injection in git commit message via `CAH_PLAN` env var

**File:** `src/cloud/entrypoint/agent-entrypoint.ts:171`
**Issue:** The `commitMessage` string is interpolated directly into a shell command:
```javascript
execSync(`git commit -m "${commitMessage}"`, { cwd: workDir, encoding: 'utf-8' });
```
`commitMessage` is `feat(${phase}-${plan}): agent task execution` where `plan = process.env.CAH_PLAN ?? ''`. If `CAH_PLAN` contains a double-quote, backtick, or `$()` sequence, the shell will interpret it. Although the CDK construct controls this env var today, any future misconfiguration or test harness that passes an untrusted plan name creates a code-execution path on the sandbox host.

**Fix:** Use the array form of `execSync` via `spawnSync`, or pass `--message` as a separate argument to avoid shell interpretation entirely:
```typescript
import { spawnSync } from 'node:child_process';

function commitAndPush(workDir: string, taskBranch: string, commitMessage: string): void {
  execSync('git add -A', { cwd: workDir, encoding: 'utf-8' });
  const status = execSync('git status --porcelain', {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();
  if (status.length > 0) {
    // spawnSync bypasses the shell -- no interpolation of commitMessage
    const result = spawnSync('git', ['commit', '-m', commitMessage], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(`git commit failed: ${result.stderr}`);
    }
  }
  execSync(`git push origin ${taskBranch}`, { cwd: workDir, encoding: 'utf-8' });
}
```

---

### CR-03: Postgres SSL silently degrades to `rejectUnauthorized: false` when cert file is absent

**File:** `src/cloud/postgres-client.ts:63-74`
**Issue:** `createDbPool` falls back to `{ rejectUnauthorized: false }` when the RDS CA bundle file is not present:
```typescript
ssl: ca
  ? { rejectUnauthorized: true, ca }
  : { rejectUnauthorized: false },
```
If the CA bundle is missing at Lambda runtime (e.g., deployment packaging excludes `infra/certs/`), the pool connects without certificate verification. This violates T-02-02 (SSL enforcement to prevent MITM on Daytona-to-RDS connections) and does so silently — no log warning, no startup error. The comment says this is acceptable "in unit tests with mocked pg," but there is no runtime guard to ensure this path is only taken in tests.

**Fix:** Throw at pool-creation time when running outside a test environment and the cert is missing:
```typescript
function loadRdsCaCert(): Buffer {
  try {
    return readFileSync(RDS_CA_BUNDLE_PATH);
  } catch (err) {
    if (process.env.NODE_ENV === 'test') {
      // Unit tests mock pg; cert absence is expected
      return Buffer.alloc(0);
    }
    throw new Error(
      `RDS CA bundle not found at ${RDS_CA_BUNDLE_PATH}. ` +
      'Ensure infra/certs/rds-global-bundle.pem is included in the Lambda package.',
    );
  }
}

export function createDbPool(connectionString: string): Pool {
  const ca = loadRdsCaCert();
  const sslConfig = ca.length > 0
    ? { rejectUnauthorized: true, ca }
    : { rejectUnauthorized: false }; // only reachable in test (NODE_ENV=test)
  // ...
}
```

---

## Warnings

### WR-01: `resolveApproval` does not verify that a row was updated

**File:** `src/cloud/postgres-client.ts:391-413`
**Issue:** The `UPDATE approvals SET ... WHERE token = $3 AND status = 'pending'` query only updates rows still in `pending` state. However, `resolveApproval` does not inspect `result.rowCount`. Under a concurrent double-click scenario, two webhook invocations can both pass the `approval.status !== 'pending'` check (line 168 in `slack-handler.ts`) if they arrive simultaneously before either has written to the DB, and both will call `resolveApproval`. The second call silently succeeds (returns `void`) despite updating zero rows, which means the caller has no way to detect the race. In the approval flow this results in two SQS messages being sent for the same pipeline run.

**Fix:**
```typescript
export async function resolveApproval(
  pool: Pool,
  token: string,
  status: 'approved' | 'rejected',
  resolvedBy: string,
): Promise<boolean> {  // return true if a row was actually updated
  const sql = `
    UPDATE approvals
    SET status = $1, resolved_at = NOW(), resolved_by = $2
    WHERE token = $3 AND status = 'pending'
  `;
  try {
    const result = await pool.query(sql, [status, resolvedBy, token]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) { /* ... */ }
}
```
Then in `handleSlackAction` (line 174), check the return value and skip SQS enqueue if `false`.

---

### WR-02: `LINEAR_STATE_MAP` `JSON.parse` is not guarded against malformed input

**File:** `src/cloud/integrations/linear.ts:89`
**Issue:** `getLinearConfig()` calls `JSON.parse(process.env.LINEAR_STATE_MAP ?? '{}')` without a try/catch. If the env var is set but contains invalid JSON (e.g., a truncated value from a CDK deploy race), every Linear API call throws a raw `SyntaxError` that is not caught by the `LinearClientError` wrapper, producing an opaque error without operation context. It also calls `JSON.parse` on every invocation (no caching), which re-parses on every `updateTicketStatus` call.

**Fix:**
```typescript
function getLinearConfig(): { teamId: string; states: Record<string, string> } {
  const teamId = process.env.LINEAR_TEAM_ID ?? '';
  let states: Record<string, string> = {};
  const raw = process.env.LINEAR_STATE_MAP;
  if (raw) {
    try {
      states = JSON.parse(raw) as Record<string, string>;
    } catch {
      throw new LinearClientError(
        `LINEAR_STATE_MAP contains invalid JSON: ${raw.slice(0, 80)}`,
        'getLinearConfig',
      );
    }
  }
  return { teamId, states };
}
```

---

### WR-03: `commitAndPush` also interpolates `taskBranch` into shell without validation

**File:** `src/cloud/entrypoint/agent-entrypoint.ts:176`
**Issue:** `git push origin ${taskBranch}` interpolates `taskBranch` into the shell string. `taskBranch` is constructed as `cah/${runId}/${phase}-${plan}-${wave}` where `runId` is from `CAH_RUN_ID`, `phase` from `CAH_PHASE`, `plan` from `CAH_PLAN`, and `wave` from `CAH_WAVE`. While `runId` is a UUID (safe), `plan` and `wave` are not validated. A value like `main; rm -rf /` in `CAH_PLAN` would execute after the `git push`. This shares the root cause with CR-02 and should be fixed together.

**Fix:** Same as CR-02 — use `spawnSync` with an explicit argument array for the push as well:
```typescript
spawnSync('git', ['push', 'origin', taskBranch], {
  cwd: workDir,
  encoding: 'utf-8',
  stdio: 'inherit',
});
```

---

### WR-04: `handleSlackAction` builds `StageMessage` with potentially empty `repoUrl` and `branch`

**File:** `src/cloud/webhook/slack-handler.ts:200-215`
**Issue:** When resuming the pipeline on approval, the handler reconstructs the `StageMessage` from `pipelineRun.config`:
```typescript
repoUrl: (config.repoUrl as string) ?? '',
branch: (config.branch as string) ?? '',
```
The `config` column is stored via `insertPipelineRun` which does not guarantee these fields are present (it only stores `{ featureDescription }`). `feature_branch` and `linearParentTicketId` are in separate columns of `pipeline_runs`, not in `config`. If `repoUrl` or `branch` is missing, the Execute stage will receive empty strings and silently fail when attempting git operations. The intake handler stores `repoUrl` and `branch` directly on the row, so they should be read from dedicated columns, not from the JSON config blob.

**Fix:** Read the dedicated columns instead of the config blob:
```typescript
// In getPipelineRun / the Postgres query for handleSlackAction, 
// ensure the full pipeline_runs row is selected:
const nextMsg: StageMessage = {
  runId: approval.pipelineRunId,
  projectId: pipelineRun.projectId,
  repoUrl: pipelineRun.repoUrl,   // dedicated column
  branch: pipelineRun.branch,     // dedicated column
  stage: nextStage,
  context: {
    featureDescription: (config.featureDescription as string) ?? '',
    phaseNumber: pipelineRun.phaseCurrent,
    phaseTotal: pipelineRun.phaseTotal,
    previousArtifacts: [],
    featureBranch: pipelineRun.featureBranch,       // dedicated column
    linearParentTicketId: pipelineRun.linearParentTicketId, // dedicated column
  },
};
```
This requires updating `PipelineRun` in `types.ts` and `mapRowToPipelineRun` in `postgres-client.ts` to include `repoUrl`, `branch`, `featureBranch`, and `linearParentTicketId`.

---

## Info

### IN-01: `parseRepoUrl` is duplicated between `intake.ts` and `pr.ts`

**File:** `src/cloud/pipeline/stages/intake.ts:33-54` and `src/cloud/pipeline/stages/pr.ts:31-49`
**Issue:** The `parseRepoUrl` function is copy-pasted with identical logic in both files. Any future bug fix must be applied in two places.

**Fix:** Extract to a shared utility, e.g. `src/cloud/pipeline/utils/repo.ts`, and import from both stage handlers.

---

### IN-02: PostHog client initialized with empty API key when `POSTHOG_API_KEY` is unset

**File:** `src/cloud/analytics.ts:20`
**Issue:** `new PostHog(process.env.POSTHOG_API_KEY ?? '', ...)` silently initializes the client with an empty string key. PostHog will accept the initialization but will fail to ingest events. No warning is logged, making it invisible that analytics are silently dropped in environments where the env var was not set.

**Fix:** Log a warning when the key is empty:
```typescript
const apiKey = process.env.POSTHOG_API_KEY ?? '';
if (!apiKey) {
  console.log(JSON.stringify({ level: 'warn', message: 'POSTHOG_API_KEY not set; analytics events will be dropped' }));
}
client = new PostHog(apiKey, { ... });
```

---

### IN-03: `LINEAR_TEAM_ID` is not validated and silently defaults to empty string

**File:** `src/cloud/integrations/linear.ts:87`
**Issue:** `teamId: process.env.LINEAR_TEAM_ID ?? ''` — if the env var is not set, `createIssue` will be called with `teamId: ''`, and the Linear API will return an error that surfaces as a `LinearClientError` with a confusing message about the team not being found. The root cause (missing env var) is not surfaced.

**Fix:** Add explicit validation in `getLinearConfig()`:
```typescript
const teamId = process.env.LINEAR_TEAM_ID;
if (!teamId) throw new LinearClientError('LINEAR_TEAM_ID not set', 'getLinearConfig');
```

---

### IN-04: `slack-webhook` CDK construct omits `SLACK_BOT_TOKEN_SECRET_ARN` from Lambda environment

**File:** `infra/lib/constructs/slack-webhook.ts:146-151`
**Issue:** The Lambda environment block includes `SLACK_SIGNING_SECRET_ARN` and `DB_SECRET_ARN` but not `SLACK_BOT_TOKEN_SECRET_ARN`. The `slackBotToken` secret ARN is granted in the IAM policy (line 127) but never passed to the Lambda as an env var. `slack-handler.ts` does not use a bot token directly, so this is not a current runtime failure. However, `src/cloud/integrations/slack.ts` reads `SLACK_BOT_TOKEN_SECRET_ARN` at runtime. If `slack-handler.ts` ever calls `sendApprovalMessage` or other Slack API operations, the missing env var will cause a silent failure. The CDK construct should set what it grants.

**Fix:**
```typescript
environment: {
  STAGE_QUEUE_URL: props.stageQueueUrl,
  SLACK_SIGNING_SECRET_ARN: props.slackSigningSecret.secretArn,
  SLACK_BOT_TOKEN_SECRET_ARN: props.slackBotToken.secretArn,
  DB_SECRET_ARN: props.dbSecretArn,
},
```

---

_Reviewed: 2026-04-16T18:50:53Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

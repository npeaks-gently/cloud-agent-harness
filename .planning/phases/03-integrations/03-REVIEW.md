---
phase: 03-integrations
reviewed: 2026-04-16T19:20:58Z
depth: standard
files_reviewed: 27
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
findings:
  critical: 4
  warning: 6
  info: 4
  total: 14
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-16T19:20:58Z
**Depth:** standard
**Files Reviewed:** 27
**Status:** issues_found

## Summary

Phase 03 delivers the integrations layer: Slack webhook approval flow, GitHub branch/PR management, Linear ticket lifecycle, PostHog analytics, CDK infrastructure, and database migrations. The code is well-structured, follows project conventions closely, and has thorough unit test coverage. The Slack HMAC-SHA256 verification, UUID approval tokens, parameterized SQL, and Secrets Manager caching all follow sound patterns.

Four critical issues require attention before this code handles production traffic: a shell injection vulnerability in the git commit command, a Slack signature verification bug when API Gateway delivers base64-encoded bodies, a silent SSL downgrade when the RDS CA cert file is absent, and a DB pool created-and-destroyed on every Lambda invocation. Six warnings cover logic gaps that can cause subtle failures under concurrent or misconfigured conditions.

---

## Critical Issues

### CR-01: Shell injection via commit message in `commitAndPush`

**File:** `src/cloud/entrypoint/agent-entrypoint.ts:170`
**Issue:** The commit message is interpolated directly into a shell string:
```ts
execSync(`git commit -m "${commitMessage}"`, { cwd: workDir, encoding: 'utf-8' });
```
`commitMessage` is assembled as `` `feat(${phase}-${plan}): agent task execution` `` where `phase` and `plan` come from `process.env.CAH_PHASE` and `process.env.CAH_PLAN`. These are read from environment variables that could contain shell metacharacters (double-quotes, backticks, `$(...)`) if whoever creates the Daytona sandbox passes an untrusted plan name. An attacker who controls those env vars can achieve arbitrary command execution inside the sandbox at commit time.

**Fix:** Use the array form via `spawnSync` to avoid shell interpretation entirely:
```ts
import { spawnSync } from 'node:child_process';

// Replace execSync string interpolation with:
const result = spawnSync('git', ['commit', '-m', commitMessage], {
  cwd: workDir,
  encoding: 'utf-8',
  stdio: 'pipe',
});
if (result.status !== 0) {
  throw new Error(`git commit failed: ${String(result.stderr)}`);
}
```
The same issue applies to `git push origin ${taskBranch}` at line 176 and `git checkout -b ${branchName} origin/${featureBranch}` at line 144 — all should use `spawnSync` with argument arrays.

---

### CR-02: Signature verification uses raw (possibly base64-encoded) body; decoded body used for parsing

**File:** `src/cloud/webhook/slack-handler.ts:125,132-135`
**Issue:** Slack signature verification is called at line 125 with the raw `event.body`. Base64 decoding happens only afterward at lines 132-135. When API Gateway delivers a base64-encoded body (`event.isBase64Encoded === true`), `verifySlackSignature` is called with the base64 string, but Slack computed its HMAC over the decoded UTF-8 string. Every request with a base64-encoded body will fail signature verification (returns 401) even for legitimate Slack callbacks. Conversely, performing verification on the non-decoded body when encoding is absent is correct, but the current code is inconsistent between the two API Gateway body delivery modes.

**Fix:** Decode first, then verify against the decoded string:
```ts
const rawBody = event.isBase64Encoded && event.body
  ? Buffer.from(event.body, 'base64').toString('utf-8')
  : (event.body ?? '');

const signingSecret = await getSigningSecret();
if (!verifySlackSignature(signingSecret, timestamp, rawBody, slackSignature)) {
  return { statusCode: 401, body: 'Invalid signature' };
}

// rawBody is now both verified and ready to parse
const params = new URLSearchParams(rawBody);
```

---

### CR-03: Postgres SSL silently degrades to `rejectUnauthorized: false` when CA cert file is absent

**File:** `src/cloud/postgres-client.ts:26-74`
**Issue:** `loadRdsCaCert()` catches any file-not-found error and returns `undefined`. `createDbPool()` then falls back to `{ rejectUnauthorized: false }` (line 68). If the CA bundle is not present at the expected path at Lambda runtime (e.g., deployment packaging excluded `infra/certs/`), the pool connects without certificate validation, silently violating T-02-02 (SSL enforcement to prevent MITM). No log warning or startup error is emitted; the degradation is invisible.

**Fix:** Fail loudly at pool-creation time outside test environments when the cert is missing:
```ts
function loadRdsCaCert(): Buffer | undefined {
  try {
    return readFileSync(RDS_CA_BUNDLE_PATH);
  } catch {
    if (process.env.NODE_ENV === 'test') return undefined;
    throw new Error(
      `RDS CA bundle not found at ${RDS_CA_BUNDLE_PATH}. ` +
      'Ensure infra/certs/rds-global-bundle.pem is included in the Lambda package.',
    );
  }
}
```

---

### CR-04: Slack webhook Lambda creates and destroys a Postgres pool on every invocation

**File:** `src/cloud/webhook/slack-handler.ts:261-275`
**Issue:** The `handler` entry point calls `createDbPool(databaseUrl)` and `pool.end()` on every invocation. This creates a new connection pool (up to 5 connections) and immediately drains it after each request. Under burst load (multiple concurrent Slack button clicks), this can exhaust the RDS connection limit. It also defeats the purpose of a connection pool — warm Lambda invocations gain no benefit from connection reuse.

**Fix:** Cache the pool at module scope, matching the pattern used for all other secrets in this codebase:
```ts
let _pool: Pool | undefined;

function getPool(): Pool {
  if (!_pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL not set');
    const { createDbPool } = require('../postgres-client.js');
    _pool = createDbPool(databaseUrl);
  }
  return _pool;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  return handleSlackAction(event, getPool());
  // Do NOT call pool.end() -- pool is reused across warm invocations
};
```

---

## Warnings

### WR-01: `timingSafeEqual` will throw when signature strings have different byte lengths

**File:** `src/cloud/webhook/slack-handler.ts:89-92`
**Issue:** `crypto.timingSafeEqual` requires both Buffer arguments to have identical byte lengths. If the incoming `x-slack-signature` header is truncated, malformed, or differs in format from the expected `v0=` + 64-char hex, the two Buffers will have different lengths and Node.js throws `TypeError: Input buffers must have the same byte length`. This unhandled exception propagates out of `verifySlackSignature`, bypassing the structured 401 response and causing 500 responses visible to the caller.

**Fix:**
```ts
const a = Buffer.from(mySignature);
const b = Buffer.from(signature);
if (a.length !== b.length) return false;
return timingSafeEqual(a, b);
```

---

### WR-02: `resolveApproval` does not check rows affected — double-click race can enqueue pipeline twice

**File:** `src/cloud/postgres-client.ts:391-413`
**Issue:** The `UPDATE ... WHERE token = $3 AND status = 'pending'` query returns `rowCount: 0` silently when zero rows match. Under a concurrent double-click, two webhook invocations can both pass the `approval.status !== 'pending'` check in `slack-handler.ts` (line 168) before either has committed its update, both call `resolveApproval`, and both go on to send an SQS message — enqueuing the pipeline twice. The fix at the DB layer is to inspect `rowCount` and only enqueue when the row was actually updated.

**Fix:**
```ts
export async function resolveApproval(
  pool: Pool,
  token: string,
  status: 'approved' | 'rejected',
  resolvedBy: string,
): Promise<boolean> {  // true if a row was updated
  const sql = `UPDATE approvals SET status = $1, resolved_at = NOW(), resolved_by = $2 WHERE token = $3 AND status = 'pending'`;
  try {
    const result = await pool.query(sql, [status, resolvedBy, token]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) { /* ... */ }
}
```
In `handleSlackAction`, gate the SQS send on the return value of `resolveApproval`.

---

### WR-03: `handleSlackAction` reconstructs `StageMessage` with `repoUrl`/`branch` from JSON config blob, not dedicated columns

**File:** `src/cloud/webhook/slack-handler.ts:200-215`
**Issue:** When resuming the pipeline on approval, the handler reads `config.repoUrl` and `config.branch` from the JSON config column (lines 203-204). But `insertPipelineRun` in `postgres-client.ts` only stores `{ featureDescription }` in the config column; `repoUrl` and `branch` are stored in dedicated table columns. Similarly, `featureBranch` and `linearParentTicketId` are in their own columns (added by the migration), not in the config blob. The result is that `repoUrl` and `branch` will always be empty strings, causing the downstream Execute stage to fail its git and GitHub operations silently.

**Fix:** Update `PipelineRun` in `types.ts` and `mapRowToPipelineRun` in `postgres-client.ts` to expose `repoUrl`, `branch`, `featureBranch`, and `linearParentTicketId` as typed fields, then read them directly:
```ts
repoUrl: pipelineRun.repoUrl,
branch: pipelineRun.branch,
context: {
  featureBranch: pipelineRun.featureBranch,
  linearParentTicketId: pipelineRun.linearParentTicketId,
  ...
},
```

---

### WR-04: `LINEAR_STATE_MAP` `JSON.parse` is not guarded and re-parsed on every call

**File:** `src/cloud/integrations/linear.ts:89`
**Issue:** `getLinearConfig()` calls `JSON.parse(process.env.LINEAR_STATE_MAP ?? '{}')` without a try/catch. If the env var contains invalid JSON (e.g., truncated value from a deployment race), every Linear API call throws a raw `SyntaxError` that is not wrapped in a `LinearClientError`, bypassing the consistent error type convention. Additionally, `getLinearConfig()` is called on every function call, re-parsing the JSON on each `updateTicketStatus` invocation.

**Fix:**
```ts
function getLinearConfig(): { teamId: string; states: Record<string, string> } {
  const teamId = process.env.LINEAR_TEAM_ID;
  if (!teamId) throw new LinearClientError('LINEAR_TEAM_ID not set', 'getLinearConfig');
  let states: Record<string, string> = {};
  const raw = process.env.LINEAR_STATE_MAP;
  if (raw) {
    try {
      states = JSON.parse(raw) as Record<string, string>;
    } catch {
      throw new LinearClientError(
        `LINEAR_STATE_MAP contains invalid JSON`,
        'getLinearConfig',
      );
    }
  }
  return { teamId, states };
}
```

---

### WR-05: `featureDescription` user content is not length-limited before use in Linear and GitHub API titles

**File:** `src/cloud/integrations/linear.ts:118`, `src/cloud/pipeline/stages/pr.ts:88`
**Issue:** `featureDescription` is free-text user input from the SQS `PipelineJobMessage`. It is placed verbatim into Linear ticket titles and GitHub PR titles with no length limit. Both APIs enforce maximum title lengths (Linear ~255 chars, GitHub ~256 chars). An excessively long description will cause an API error with a confusing message; the root cause (oversized input) will not be obvious.

**Fix:** Truncate before use in external API titles:
```ts
const safeDescription = featureDescription.slice(0, 200).trim();
// Use safeDescription in title construction
```

---

### WR-06: `parseRepoUrl` is duplicated between `intake.ts` and `pr.ts`

**File:** `src/cloud/pipeline/stages/intake.ts:33-54`, `src/cloud/pipeline/stages/pr.ts:31-49`
**Issue:** The `parseRepoUrl` function is implemented identically in two files with no shared import. A bug fix or edge-case handling in one copy must be replicated manually in the other.

**Fix:** Extract to a shared utility (e.g., `src/cloud/pipeline/utils.ts`) and import from both stage handlers. The existing `parseRepoUrl` tests in `intake-intg.test.ts` would carry over naturally.

---

## Info

### IN-01: `SLACK_BOT_TOKEN_SECRET_ARN` is granted in IAM but not set in Lambda environment

**File:** `infra/lib/constructs/slack-webhook.ts:146-151`
**Issue:** The Lambda environment block sets `SLACK_SIGNING_SECRET_ARN` and `DB_SECRET_ARN` but not `SLACK_BOT_TOKEN_SECRET_ARN`. The `slackBotToken` ARN is included in the IAM policy (line 127) so the permission exists, but the env var is missing. If the webhook handler ever calls any Slack API (e.g., to update the approval message to show who approved it), `getSlackBotToken()` will throw "SLACK_BOT_TOKEN_SECRET_ARN not set."

**Fix:**
```ts
environment: {
  STAGE_QUEUE_URL: props.stageQueueUrl,
  SLACK_SIGNING_SECRET_ARN: props.slackSigningSecret.secretArn,
  SLACK_BOT_TOKEN_SECRET_ARN: props.slackBotToken.secretArn,  // add this
  DB_SECRET_ARN: props.dbSecretArn,
},
```

---

### IN-02: PostHog client initialized with empty API key when `POSTHOG_API_KEY` is not set

**File:** `src/cloud/analytics.ts:20`
**Issue:** `new PostHog(process.env.POSTHOG_API_KEY ?? '', ...)` silently initializes the client with an empty string when the env var is absent. PostHog will accept the empty key but fail to ingest events. No warning is logged, so analytics drops are invisible in environments where the env var was not configured.

**Fix:**
```ts
const apiKey = process.env.POSTHOG_API_KEY ?? '';
if (!apiKey) {
  console.log(JSON.stringify({ level: 'warn', message: 'POSTHOG_API_KEY not set; analytics events will be dropped' }));
}
client = new PostHog(apiKey, { host: 'https://us.i.posthog.com', flushAt: 1, flushInterval: 0 });
```

---

### IN-03: `flush()` is only called in the `execute` case, not in `research`/`plan`/`verify`

**File:** `src/cloud/entrypoint/agent-entrypoint.ts:259`
**Issue:** `flush()` is called at the end of the `execute` case only. The `research`, `plan`, and `verify` cases do not call `flush()`. If those stages ever call `track()` internally, events would be lost on Lambda exit without error.

**Fix:** Move `await flush()` outside and after the `switch` statement so it always runs regardless of stage.

---

### IN-04: `insertApproval` returns empty string on conflict — caller has no way to detect silent deduplication

**File:** `src/cloud/postgres-client.ts:319-334`
**Issue:** `ON CONFLICT (token) DO NOTHING` causes `RETURNING id` to return zero rows on a conflict. The function returns `''` in this case (line 325). The caller in `approve.ts` ignores the return value. While UUID token collision is cryptographically negligible, the silent return of `''` makes it impossible to detect or alert on unexpected conflicts during debugging or anomaly analysis.

**Fix:** Return a discriminated result to distinguish insertion from deduplication:
```ts
return { id: (result.rows[0]?.id as string) ?? '', inserted: result.rows.length > 0 };
```

---

_Reviewed: 2026-04-16T19:20:58Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

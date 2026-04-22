---
phase: 03-integrations
fixed_at: 2026-04-16T19:39:03Z
review_path: .planning/phases/03-integrations/03-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

**Fixed at:** 2026-04-16T19:39:03Z
**Source review:** .planning/phases/03-integrations/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 10
- Fixed: 10
- Skipped: 0

## Fixed Issues

### CR-01: Shell injection via commit message in `commitAndPush`

**Files modified:** `src/cloud/entrypoint/agent-entrypoint.ts`
**Commit:** 159de2d
**Applied fix:** Replaced all shell-interpolated `execSync` calls in `createTaskBranch` and `commitAndPush` with `spawnSync` using argument arrays. This covers `git commit -m`, `git push origin`, `git fetch origin`, and `git checkout -b` -- all of which previously interpolated variables into shell strings. Added `spawnSync` to the import and added explicit error checking on each spawn result's status code.

### CR-02: Signature verification uses raw (possibly base64-encoded) body; decoded body used for parsing

**Files modified:** `src/cloud/webhook/slack-handler.ts`
**Commit:** c044786
**Applied fix:** Moved base64 decoding before signature verification so `verifySlackSignature` receives the same bytes Slack used to compute the HMAC. The decoded `rawBody` is now used for both signature verification and URL-encoded payload parsing.

### CR-03: Postgres SSL silently degrades to `rejectUnauthorized: false` when CA cert file is absent

**Files modified:** `src/cloud/postgres-client.ts`
**Commit:** c75da9d
**Applied fix:** Changed `loadRdsCaCert()` to throw an Error with a descriptive message when the CA bundle file is missing, except when `NODE_ENV === 'test'` (where mocked pg is used). This prevents silent SSL downgrade in production Lambda environments.

### CR-04: Slack webhook Lambda creates and destroys a Postgres pool on every invocation

**Files modified:** `src/cloud/webhook/slack-handler.ts`
**Commit:** aa315bf
**Applied fix:** Replaced per-invocation pool creation/teardown with a module-scoped `_pool` variable and a `getPool()` function that creates the pool on first call (cold start) and returns the cached instance on subsequent warm invocations. Removed the `pool.end()` call from the handler -- the pool persists across warm invocations for connection reuse.

### WR-01: `timingSafeEqual` will throw when signature strings have different byte lengths

**Files modified:** `src/cloud/webhook/slack-handler.ts`
**Commit:** 55d528b
**Applied fix:** Added a length check before calling `timingSafeEqual`. If the computed signature buffer and the incoming signature buffer differ in length, the function returns `false` immediately instead of throwing a `TypeError`.

### WR-02: `resolveApproval` does not check rows affected -- double-click race can enqueue pipeline twice

**Files modified:** `src/cloud/postgres-client.ts`, `src/cloud/webhook/slack-handler.ts`
**Commit:** f8fc736
**Applied fix:** Changed `resolveApproval` return type from `Promise<void>` to `Promise<boolean>`, returning `(result.rowCount ?? 0) > 0`. In `handleSlackAction`, the SQS send is now gated on `wasResolved` -- if `resolveApproval` returns false (concurrent request already resolved), the handler returns early with 200 "Already processed".

### WR-03: `handleSlackAction` reconstructs `StageMessage` with `repoUrl`/`branch` from JSON config blob, not dedicated columns

**Files modified:** `src/cloud/types.ts`, `src/cloud/postgres-client.ts`, `src/cloud/webhook/slack-handler.ts`
**Commit:** 3658a83
**Applied fix:** Added `repoUrl`, `branch`, `featureDescription`, `featureBranch`, and `linearParentTicketId` fields to the `PipelineRun` interface. Updated `mapRowToPipelineRun` to read these from their dedicated DB columns (`repo_url`, `branch`, `feature_description`, `feature_branch`, `linear_parent_ticket_id`). Updated `handleSlackAction` to read directly from the typed PipelineRun fields instead of the JSON config blob.

### WR-04: `LINEAR_STATE_MAP` `JSON.parse` is not guarded and re-parsed on every call

**Files modified:** `src/cloud/integrations/linear.ts`
**Commit:** 1a53381
**Applied fix:** Wrapped `JSON.parse(LINEAR_STATE_MAP)` in a try/catch that throws `LinearClientError` on invalid JSON. Added validation that `LINEAR_TEAM_ID` is set (throws `LinearClientError` if missing). Cached the parsed config in module-scoped `cachedLinearConfig` so parsing only happens once per Lambda cold start.

### WR-05: `featureDescription` user content is not length-limited before use in Linear and GitHub API titles

**Files modified:** `src/cloud/integrations/linear.ts`, `src/cloud/pipeline/stages/pr.ts`
**Commit:** 27bcd4e
**Applied fix:** Added `featureDescription.slice(0, 200).trim()` before using the description in Linear ticket titles and GitHub PR titles. The full description is still preserved in the description/body fields.

### WR-06: `parseRepoUrl` is duplicated between `intake.ts` and `pr.ts`

**Files modified:** `src/cloud/pipeline/utils.ts` (new), `src/cloud/pipeline/stages/intake.ts`, `src/cloud/pipeline/stages/pr.ts`
**Commit:** 4f4b095
**Applied fix:** Extracted `parseRepoUrl` to a new shared utility file `src/cloud/pipeline/utils.ts`. Both `intake.ts` and `pr.ts` now import from `utils.js`. The function accepts optional `callerOperation` and `callerStage` parameters for error context. A re-export from `intake.ts` maintains backward compatibility with existing test imports.

---

_Fixed: 2026-04-16T19:39:03Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

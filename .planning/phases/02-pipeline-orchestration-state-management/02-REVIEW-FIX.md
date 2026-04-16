---
phase: 02-pipeline-orchestration-state-management
fixed_at: 2026-04-16T11:12:00Z
review_path: .planning/phases/02-pipeline-orchestration-state-management/02-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 02: Code Review Fix Report

**Fixed at:** 2026-04-16T11:12:00Z
**Source review:** .planning/phases/02-pipeline-orchestration-state-management/02-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (2 critical, 5 warning)
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-01: Anthropic API key passed as plaintext env var into Daytona sandbox

**Files modified:** `src/cloud/pipeline/sandbox-task.ts`
**Commit:** 470054b
**Applied fix:** Added `getAnthropicApiKey()` function that fetches the key from Secrets Manager using `ANTHROPIC_API_KEY_SECRET_ARN` env var and caches it in module scope at Lambda cold start. Replaced the broken `process.env.ANTHROPIC_API_KEY ?? ''` (which always yielded empty string) with the resolved secret value. Updated JSDoc to reflect the new sourcing mechanism.

### CR-02: S3 listing in downloadPlanningDir is not paginated

**Files modified:** `src/cloud/entrypoint/s3-sync.ts`
**Commit:** d879355
**Applied fix:** Wrapped the `ListObjectsV2Command` call in a `do...while` loop that follows `NextContinuationToken` until `IsTruncated` is false. Previously, pipelines with more than 1,000 planning files would silently lose data beyond the first page. Also incorporated the WR-05 fix in the same edit (moved `mkdir` after Body-presence check).

### WR-01: Failed stage does not mark pipeline_runs as failed in Postgres

**Files modified:** `src/cloud/pipeline/stage-router.ts`
**Commit:** d6a9e3b
**Applied fix:** Added a `result.status === 'failed'` branch that updates `pipeline_runs` to `status = 'failed'` at the current stage instead of advancing to the next stage. The SQS next-stage message is only sent on success. Previously a failed pipeline appeared as 'running' at the next stage indefinitely.

### WR-02: planCount cast silently defaults to 1 on type mismatch

**Files modified:** `src/cloud/pipeline/stages/execute.ts`
**Commit:** f129c2f
**Applied fix:** Replaced the unsafe `as number` cast with a `typeof` runtime check: `typeof rawPlanCount === 'number' && rawPlanCount > 0`. This guards against string values from JSON deserialization that would bypass the `??` null-coalescing guard and cause incorrect loop behavior.

### WR-03: writeAgentCheckpoint does not write checkpoint when executeTask itself throws

**Files modified:** `src/cloud/pipeline/sandbox-task.ts`
**Commit:** ebbb36e
**Applied fix:** Wrapped the failure-path `writeAgentCheckpoint` call in its own try-catch block. If the checkpoint write also fails, the error is logged as a structured JSON warning (with both original and checkpoint error messages) and the original `executeTask` error is preserved in the thrown `PipelineError`. Previously the checkpoint error would mask the original failure context.

### WR-04: git diff command misses untracked new files created by agent

**Files modified:** `src/cloud/entrypoint/agent-entrypoint.ts`
**Commit:** f14f7e5
**Applied fix:** Replaced `git diff --name-only HEAD` with `git status --porcelain` to capture both tracked modifications and untracked new files. Added filters to exclude deleted files (status `D`) and strip the porcelain status prefix from each line. Updated JSDoc to document the new behavior.

### WR-05: S3 download skips objects when Body is absent but still creates empty directories

**Files modified:** `src/cloud/entrypoint/s3-sync.ts`
**Commit:** d879355 (combined with CR-02)
**Applied fix:** Moved the `mkdir(dirname(fullPath), { recursive: true })` call to after the `if (!getResponse.Body) continue` check, so directories are only created when the file content will actually be written. This was applied as part of the CR-02 pagination fix since both changes affected the same loop body.

## Verification

All 30 tests across the 3 affected test files pass after fixes:
- `src/cloud/test/s3-sync.test.ts` -- passed
- `src/cloud/test/stage-router.test.ts` -- passed
- `src/cloud/test/entrypoint.test.ts` -- passed

---

_Fixed: 2026-04-16T11:12:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

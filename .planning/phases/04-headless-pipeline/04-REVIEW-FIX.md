---
phase: 04-headless-pipeline
fixed_at: 2026-04-17T13:37:00Z
review_path: .planning/phases/04-headless-pipeline/04-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-04-17T13:37:00Z
**Source review:** .planning/phases/04-headless-pipeline/04-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0

**Full test suite:** 220/220 tests passing (cloud-unit)

## Fixed Issues

### CR-01: Escalation resume reads `currentStage` from wrong source -- always falls back to Execute

**Files modified:** `src/cloud/types.ts`, `src/cloud/postgres-client.ts`, `src/cloud/webhook/slack-handler.ts`
**Commit:** fdb655e
**Applied fix:** Added `currentStage?: string` field to the `PipelineRun` interface in `types.ts`, mapped `row.current_stage` in `mapRowToPipelineRun` in `postgres-client.ts`, and changed `slack-handler.ts:209` from `pipelineRun.config.currentStage` to `pipelineRun.currentStage` so escalation resume reads the actual database column instead of always falling back to Execute.

### WR-01: `insertApproval` accepts unconstrained string for `approvalType` -- no validation

**Files modified:** `src/cloud/postgres-client.ts`
**Commit:** c33cd1e
**Applied fix:** Introduced `ApprovalType = 'plan_approval' | 'risk_escalation'` union type, changed the `approvalType` parameter of `insertApproval` from `string` to `ApprovalType`, and updated the `getApprovalByToken` return type to use `ApprovalType` instead of `string` for compile-time enforcement.

### WR-02: Intake planningPrefix UUID regex accepts all-hyphens and non-UUID patterns

**Files modified:** `src/cloud/pipeline/stages/intake.ts`
**Commit:** 44ff2ba
**Applied fix:** Replaced the loose regex `/^triggers\/[0-9a-f-]{36}\/planning\/$/` with a strict UUID v4 pattern `/^triggers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/planning\/$/` that validates the 8-4-4-4-12 hyphenation structure.

### WR-03: `cah-dispatch` direct-run detection is fragile

**Files modified:** `src/cloud/dispatch/cah-dispatch.ts`
**Commit:** dc0890c
**Applied fix:** Replaced `process.argv[1]?.includes('cah-dispatch')` with the standard ESM direct-run detection pattern `process.argv[1] === fileURLToPath(import.meta.url)`, adding the `fileURLToPath` import from `node:url`.

### WR-04: `cah-dispatch` credential check creates a throwaway S3Client, then `dispatch()` creates another

**Files modified:** `src/cloud/dispatch/cah-dispatch.ts`
**Commit:** adbf54f
**Applied fix:** Moved `const s3 = new S3Client(...)` before the try block so it is reusable, and passed it as the second argument to `dispatch(options, s3)` so the credential-checked client is reused instead of creating a second instance.

---

_Fixed: 2026-04-17T13:37:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

---
phase: 04-headless-pipeline
reviewed: 2026-04-17T14:30:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - agents/auto-decider.md
  - scripts/migrate-004-approval-type.sql
  - sdk/src/context-engine.ts
  - sdk/src/phase-prompt.ts
  - sdk/src/phase-runner.ts
  - sdk/src/tool-scoping.ts
  - sdk/src/types.ts
  - src/cloud/dispatch/cah-dispatch.ts
  - src/cloud/integrations/slack.ts
  - src/cloud/pipeline/stage-router.ts
  - src/cloud/pipeline/stages/approve.ts
  - src/cloud/pipeline/stages/intake.ts
  - src/cloud/pipeline/types.ts
  - src/cloud/postgres-client.ts
  - src/cloud/types.ts
  - src/cloud/webhook/slack-handler.ts
findings:
  critical: 1
  warning: 4
  info: 2
  total: 7
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-04-17T14:30:00Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

Phase 04 implements the headless pipeline extension: shared type contracts (planningPrefix, PhaseStepType.AutoDecide, approval_type migration), the auto-decider agent + PhaseRunner integration, Slack escalation messaging, webhook handler extension for escalation actions, cah-dispatch CLI script, and intake-stage planning artifact download.

The code is generally well-structured and follows established project patterns (injectable clients for testability, parameterized SQL, structured error handling). However, there is one critical bug in the webhook handler's escalation resume logic, several warnings around input validation gaps, and minor quality observations.

## Critical Issues

### CR-01: Escalation resume reads `currentStage` from wrong source -- always falls back to Execute

**File:** `src/cloud/webhook/slack-handler.ts:209`
**Issue:** When a `risk_escalation` approval is resolved, the handler determines the resume stage via `pipelineRun.config.currentStage`. However, `currentStage` is stored as a dedicated `current_stage` database column (written by `stage-router.ts:262` and `checkpoint.ts`), NOT inside the `config` JSONB blob. The `PipelineRun` interface in `src/cloud/types.ts` does not have a `currentStage` field, and `mapRowToPipelineRun` in `postgres-client.ts` does not map `current_stage`. Therefore `pipelineRun.config.currentStage` is always `undefined`, causing the fallback `?? PipelineStage.Execute` to always be used. This means escalation resume will always jump to the Execute stage regardless of which stage the pipeline was actually paused at.

**Fix:**
1. Add `currentStage` to the `PipelineRun` interface in `src/cloud/types.ts`:
```typescript
export interface PipelineRun {
  // ... existing fields ...
  /** Current pipeline stage (set by stage-router and checkpoint) */
  currentStage?: string;
  // ...
}
```
2. Map it in `mapRowToPipelineRun` in `src/cloud/postgres-client.ts`:
```typescript
currentStage: row.current_stage as string | undefined,
```
3. Update `slack-handler.ts:209` to use the mapped field:
```typescript
nextStage = (pipelineRun.currentStage as PipelineStage) ?? PipelineStage.Execute;
```

## Warnings

### WR-01: `insertApproval` accepts unconstrained string for `approvalType` -- no validation

**File:** `src/cloud/postgres-client.ts:326`
**Issue:** The `approvalType` parameter is typed as `string` with no validation. Any arbitrary string (including empty string, SQL-safe but semantically invalid values like `'foo'`) can be inserted. The threat model (T-04-02) states "insertApproval only accepts known values via typed parameter" but the implementation uses an unconstrained `string` default parameter. If a future caller passes an incorrect value, the webhook handler's `approval.approvalType === 'risk_escalation'` check at `slack-handler.ts:207` will silently not match, causing escalation approvals to be treated as plan approvals.

**Fix:** Use a union type or validate the input:
```typescript
export type ApprovalType = 'plan_approval' | 'risk_escalation';

export async function insertApproval(
  pool: Pool,
  pipelineRunId: string,
  token: string,
  slackChannel: string,
  slackMessageTs: string,
  approvalType: ApprovalType = 'plan_approval',
): Promise<string> {
```

### WR-02: Intake planningPrefix UUID regex accepts all-hyphens and non-UUID patterns

**File:** `src/cloud/pipeline/stages/intake.ts:92`
**Issue:** The regex `/^triggers\/[0-9a-f-]{36}\/planning\/$/` validates the prefix format but the character class `[0-9a-f-]{36}` accepts strings like `------------------------------------` (36 hyphens) or `aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-` which are not valid UUIDs. While this is not a security vulnerability (path traversal is prevented by the anchored regex), it weakens input validation and could allow processing of malformed trigger IDs that don't correspond to real dispatches.

**Fix:** Use a stricter UUID v4 pattern:
```typescript
const prefixPattern = /^triggers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/planning\/$/;
```

### WR-03: `cah-dispatch` direct-run detection is fragile

**File:** `src/cloud/dispatch/cah-dispatch.ts:237`
**Issue:** The `isDirectRun` check uses `process.argv[1]?.includes('cah-dispatch')` which can false-positive if the script is imported by another file whose path happens to contain the string "cah-dispatch" (e.g., a test runner working directory). It also fails to match if the script is invoked via a symlink or wrapper with a different name.

**Fix:** Use the standard ESM direct-run detection pattern:
```typescript
import { fileURLToPath } from 'node:url';
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
```
Note: `fileURLToPath` is already imported at the top of some other files in the codebase but not in this file. This pattern is the standard Node.js approach for ESM modules.

### WR-04: `cah-dispatch` credential check creates a throwaway S3Client, then `dispatch()` creates another

**File:** `src/cloud/dispatch/cah-dispatch.ts:209-218`
**Issue:** The `main()` function creates an S3Client at line 210 for the credential check (HeadBucketCommand), then `dispatch()` creates a second S3Client at line 105. If HeadBucketCommand succeeds (bucket exists, credentials valid) but the credentials have an expiration that occurs between the two calls, or if the region configuration differs, the dispatch could fail despite the credential check passing. More importantly, the credential check at line 214 only catches errors whose message string contains `'CredentialsProviderError'` or `'Could not load credentials'` -- other credential failures (e.g., expired STS tokens with different error messages) are silently swallowed and will fail later during actual upload with a less clear error.

**Fix:** Pass the pre-created S3Client to `dispatch()` instead of letting it create its own:
```typescript
const s3 = new S3Client({ region: DEFAULT_REGION });
try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
} catch (err) {
  // ... credential check ...
}

const result = await dispatch({ ... }, s3);
```

## Info

### IN-01: `PHASE_WORKFLOW_MAP` maps `AutoDecide` to `execute-plan.md` -- may not be intentional

**File:** `sdk/src/phase-prompt.ts:32`
**Issue:** The auto-decide phase maps to `execute-plan.md` as its workflow file. This means the auto-decider agent gets the executor's workflow instructions (purpose, process steps) rather than auto-decide-specific instructions. The `runAutoDecideStep` in phase-runner.ts appends supplemental instructions (line 458), but the base workflow is the executor's. This works because the agent definition (`auto-decider.md`) provides the role, but the workflow sections (purpose, process) will be from the executor workflow. If the auto-decider needs distinct workflow guidance in the future, this mapping should be revisited.

### IN-02: `getPhaseInstructions` in phase-prompt.ts has no case for `AutoDecide` or `Repair`

**File:** `sdk/src/phase-prompt.ts:247-262`
**Issue:** The switch statement in `getPhaseInstructions` does not have explicit cases for `PhaseType.AutoDecide` or `PhaseType.Repair`. Both fall through to the `default: return null` case. This is functionally correct because `runAutoDecideStep` in phase-runner.ts appends its own supplemental instructions, and `Repair` reuses executor logic. However, it means the `default` case silently handles two enum values without documentation. Adding explicit `case PhaseType.AutoDecide: return null;` and `case PhaseType.Repair: return null;` would make the intent clear and prevent future maintainers from wondering if these were overlooked.

---

_Reviewed: 2026-04-17T14:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

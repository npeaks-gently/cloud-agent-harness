---
phase: 02-pipeline-orchestration-state-management
plan: 02
subsystem: cloud-entrypoint
tags: [s3-sync, agent-entrypoint, daytona, sandbox, context-provisioning]
dependency_graph:
  requires: [src/cloud/s3-artifacts.ts, sdk/src/index.ts]
  provides: [src/cloud/entrypoint/s3-sync.ts, src/cloud/entrypoint/agent-entrypoint.ts, src/cloud/entrypoint/sdk-loader.ts]
  affects: [src/cloud/test/s3-sync.test.ts, src/cloud/test/entrypoint.test.ts]
tech_stack:
  added: []
  patterns: [S3-client-injection, vi-hoisted-mocks, sdk-loader-isolation]
key_files:
  created:
    - src/cloud/entrypoint/s3-sync.ts
    - src/cloud/entrypoint/agent-entrypoint.ts
    - src/cloud/entrypoint/sdk-loader.ts
    - src/cloud/test/s3-sync.test.ts
    - src/cloud/test/entrypoint.test.ts
  modified: []
decisions:
  - SDK dynamic import isolated into sdk-loader.ts for testability (vi.mock cannot intercept dynamic imports across module boundaries)
  - Used vi.hoisted() pattern for mock declarations to avoid ESM hoisting issues with vi.mock factories
metrics:
  duration: 5m
  completed: 2026-04-16T05:31:19Z
  tasks_completed: 2
  tasks_total: 2
  test_count: 19
  files_created: 5
  files_modified: 0
requirements:
  - PIPE-04
  - STATE-04
---

# Phase 02 Plan 02: S3 Context Sync & Agent Entrypoint Summary

S3 context download/upload module and Daytona sandbox entrypoint script with full test coverage following existing s3-artifacts.ts patterns.

## What Was Built

### S3 Context Sync Module (`src/cloud/entrypoint/s3-sync.ts`)

Two pure async functions for context provisioning per D-16, D-17, D-19:

- **downloadPlanningDir** -- Lists all objects under `runs/{runId}/planning/` prefix, downloads each, writes to `{targetDir}/.planning/{relativePath}` with intermediate directory creation. Returns count of files downloaded. Handles empty listings (returns 0) and missing keys/bodies gracefully.

- **uploadModifiedFiles** -- Uploads each file to `runs/{runId}/phases/{phase}/{path}` with SHA256 checksum verification. Returns array of uploaded S3 keys. Empty input returns empty array without S3 calls.

Both functions follow the s3-artifacts.ts convention: optional `S3Client` parameter for testability, `DEFAULT_REGION = 'us-east-1'`, JSDoc on every export, section dividers.

### Agent Entrypoint Script (`src/cloud/entrypoint/agent-entrypoint.ts`)

Sandbox entrypoint per D-07 that bridges "sandbox with a repo" to "agent executing a plan":

1. Reads config from `CAH_*` environment variables (CAH_RUN_ID, CAH_STAGE, CAH_PHASE, CAH_PLAN, CAH_BUCKET)
2. Validates required env vars (throws on missing CAH_RUN_ID, CAH_STAGE, CAH_BUCKET)
3. Downloads `.planning/` from S3 via `downloadPlanningDir`
4. Runs agent via SDK based on stage:
   - `research`/`plan`/`verify` -> `gsd.runPhase(phase)`
   - `execute` -> `gsd.executePlan(plan)`
   - `approve` -> no-op (auto-approve per D-10, placeholder for Phase 3 Slack)
   - `pr` -> no-op (Phase 3 INTG-02)
5. Finds modified files via `git diff --name-only HEAD`
6. Uploads modified files to S3 via `uploadModifiedFiles`
7. Writes JSON result to stdout: `{ success, costUsd, durationMs, artifacts }`

### SDK Loader (`src/cloud/entrypoint/sdk-loader.ts`)

Thin wrapper isolating the dynamic SDK import for testability. Vitest's `vi.mock` cannot intercept dynamic `await import()` across module boundaries, so the import is wrapped in a static function that vitest can mock.

## Test Coverage

- **s3-sync.test.ts** (6 tests): download with multiple files, empty listing, nested directories, skipped objects, upload with SHA256, empty upload
- **entrypoint.test.ts** (13 tests): env var validation (3), S3 download (1), agent execution per stage (7), upload (1), JSON output (1)

All 19 tests pass. Tests use `vi.hoisted()` for mock declarations and inject mock S3Client via optional parameter.

## Decisions Made

1. **SDK loader isolation**: Extracted `sdk-loader.ts` to wrap the dynamic `import()` of the SDK. This makes the entrypoint testable with vitest's `vi.mock()` which operates at the static module boundary level. The alternative (mocking the resolved absolute path of the dynamic import) is fragile and environment-dependent.

2. **vi.hoisted() pattern**: Used vitest's `vi.hoisted()` API for declaring mock functions that are referenced inside `vi.mock()` factory functions. This avoids "Cannot access before initialization" errors caused by ESM module hoisting.

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| approve stage no-op | src/cloud/entrypoint/agent-entrypoint.ts | 134 | Per D-10: auto-approve until Phase 3 Slack integration |
| pr stage no-op | src/cloud/entrypoint/agent-entrypoint.ts | 137 | Per plan: PR creation handled in Phase 3 INTG-02 |

Both stubs are intentional per the plan and context decisions. They do not prevent the plan's goal (S3 sync + entrypoint execution) from being achieved.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extracted sdk-loader.ts for testability**
- **Found during:** Task 2
- **Issue:** Dynamic `await import('../../sdk/src/index.js')` inside the entrypoint could not be mocked by vitest's `vi.mock()` because vitest intercepts static module imports, not dynamic import paths resolved at runtime.
- **Fix:** Created `src/cloud/entrypoint/sdk-loader.ts` as a thin wrapper exporting `loadSdk()`. The entrypoint imports `loadSdk` statically, and tests mock `../entrypoint/sdk-loader.js`.
- **Files created:** `src/cloud/entrypoint/sdk-loader.ts`
- **Commit:** 5f4b770

**2. [Rule 3 - Blocking] Used vi.hoisted() for mock declarations**
- **Found during:** Task 2
- **Issue:** `vi.mock()` factories are hoisted to the top of the file by vitest, before `const` declarations. Mock function variables (`mockExecSync`, etc.) referenced inside factories caused "Cannot access before initialization" errors.
- **Fix:** Wrapped mock function declarations in `vi.hoisted()` which ensures they are initialized before `vi.mock()` factories execute.
- **Files modified:** `src/cloud/test/entrypoint.test.ts`
- **Commit:** 5f4b770

## TDD Gate Compliance

| Gate | Commit | Type | Description |
|------|--------|------|-------------|
| RED (Task 1) | e4a2ca3 | test | Failing tests for S3 sync module |
| GREEN (Task 1) | e5a320f | feat | Implementation making tests pass |
| RED (Task 2) | 14c31f5 | test | Failing tests for agent entrypoint |
| GREEN (Task 2) | 5f4b770 | feat | Implementation making tests pass |

All TDD gates satisfied: RED commits exist before GREEN commits for both tasks.

## Self-Check: PASSED

All 5 created files verified on disk. All 4 commit hashes verified in git log.

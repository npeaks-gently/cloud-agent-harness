---
phase: 02-pipeline-orchestration-state-management
plan: 04
subsystem: pipeline-stage-handlers-router
tags: [pipeline, stages, router, sqs, lambda, daytona, intake, approve, pr]
dependency_graph:
  requires: [src/cloud/pipeline/types.ts, src/cloud/pipeline/idempotency.ts, src/cloud/pipeline/checkpoint.ts, src/cloud/pipeline/sandbox-task.ts, src/cloud/daytona-client.ts, src/cloud/types.ts]
  provides: [src/cloud/pipeline/stages/intake.ts, src/cloud/pipeline/stages/research.ts, src/cloud/pipeline/stages/plan.ts, src/cloud/pipeline/stages/approve.ts, src/cloud/pipeline/stages/execute.ts, src/cloud/pipeline/stages/verify.ts, src/cloud/pipeline/stages/pr.ts, src/cloud/pipeline/stage-router.ts]
  affects: [pipeline_runs table, agent_runs table, SQS stage queue]
tech_stack:
  added: []
  patterns: [dual type guard disambiguation, STAGE_HANDLERS dispatch map, PipelineJobMessage-to-StageMessage conversion, sequential plan iteration with early-exit, vi.hoisted mock pattern]
key_files:
  created:
    - src/cloud/pipeline/stages/intake.ts
    - src/cloud/pipeline/stages/approve.ts
    - src/cloud/pipeline/stages/pr.ts
    - src/cloud/pipeline/stages/research.ts
    - src/cloud/pipeline/stages/plan.ts
    - src/cloud/pipeline/stages/execute.ts
    - src/cloud/pipeline/stages/verify.ts
    - src/cloud/pipeline/stage-router.ts
    - src/cloud/test/stage-router.test.ts
  modified: []
decisions:
  - "isPipelineJobMessage checks stage===undefined to distinguish from StageMessage (T-02-12)"
  - "STAGE_HANDLERS dispatch map uses wrapper lambdas for handlers with fewer params (intake, approve, pr)"
  - "execute stage iterates plans sequentially with early-exit on failure (D-11, v2 parallel deferred)"
  - "vi.hoisted() used in tests to avoid vitest mock hoisting issues with variable references"
metrics:
  duration: 5m 28s
  completed: 2026-04-16T05:50:19Z
  tasks_completed: 3
  tasks_total: 3
  files_created: 9
  files_modified: 0
  test_count: 11
  test_pass: 11
---

# Phase 02 Plan 04: Pipeline Stage Handlers & Stage Router Summary

Seven pipeline stage handlers and SQS stage router with dual type guard dispatch for PipelineJobMessage (job queue intake) and StageMessage (inter-stage progression), plus 11-test TDD suite.

## What Was Built

### Simple Stage Handlers (no Daytona dispatch)

- **intake.ts** -- creates pipeline_run row with pre-generated runId from stage router; uses INSERT ON CONFLICT (id) DO NOTHING for idempotency; parameterized SQL (T-02-13)
- **approve.ts** -- auto-approves and logs to CloudWatch; placeholder for Phase 3 Slack integration (D-10)
- **pr.ts** -- logs completion and returns success; placeholder for Phase 3 git PR creation (INTG-02)

### Agent-Dispatch Stage Handlers (Daytona sandbox)

- **research.ts** -- dispatches single research agent via runAgentTask; checks getCompletedTasks before dispatch (D-13 resume support)
- **plan.ts** -- dispatches single planning agent via runAgentTask; same resume check pattern
- **execute.ts** -- iterates plans sequentially (planCount from context, defaults to 1); stops on first failure; skips already-completed plans via getCompletedTasks (D-13)
- **verify.ts** -- dispatches single verifier agent via runAgentTask; same resume check pattern

### Stage Router (`src/cloud/pipeline/stage-router.ts`)

- **routeStage** -- Lambda entry point that receives SQS messages from two queues:
  1. Job queue: PipelineJobMessage -> generates runId via crypto.randomUUID(), constructs intake StageMessage, dispatches to handleIntakeStage
  2. Stage queue: StageMessage -> dispatches to correct handler via STAGE_HANDLERS map
- **Dual type guards**: isStageMessage (checks runId, stage as valid PipelineStage, context object) and isPipelineJobMessage (checks featureDescription, stage===undefined to disambiguate)
- **Post-handler**: calls updatePipelineStage, sends next-stage SQS message unless terminal (PR) or failed
- **StageRouterError** for invalid JSON and unrecognized message schemas

### Unit Tests (`src/cloud/test/stage-router.test.ts`)

- 11 tests: StageMessage routing (2), PipelineJobMessage intake (2), post-handler behavior (4), error handling (2), type guard disambiguation (1)
- Uses vi.hoisted() for mock function declarations to avoid vitest hoisting issues

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Simple stage handlers (intake, approve, pr) | 99d88c0 | src/cloud/pipeline/stages/intake.ts, approve.ts, pr.ts |
| 2 | Agent-dispatch stage handlers (research, plan, execute, verify) | c57d557 | src/cloud/pipeline/stages/research.ts, plan.ts, execute.ts, verify.ts |
| 3 (RED) | Stage router failing tests | 41efba1 | src/cloud/test/stage-router.test.ts |
| 3 (GREEN) | Stage router implementation | b5d7b27 | src/cloud/pipeline/stage-router.ts, src/cloud/test/stage-router.test.ts |

## TDD Gate Compliance

- RED gate: `test(02-04)` commit 41efba1 -- 11 tests, all failing (module not found)
- GREEN gate: `feat(02-04)` commit b5d7b27 -- 11 tests, all passing
- REFACTOR gate: skipped (code follows established patterns, no cleanup needed)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed vitest mock hoisting issue in test file**
- **Found during:** Task 3 RED phase
- **Issue:** vi.mock() factories cannot reference `const` variables defined at module scope because vi.mock calls are hoisted above variable declarations by vitest
- **Fix:** Used `vi.hoisted()` to declare all mock functions, making them available during vi.mock factory execution
- **Files modified:** src/cloud/test/stage-router.test.ts
- **Commit:** b5d7b27

## Verification Results

- `npx vitest run src/cloud/test/stage-router.test.ts` -- 11/11 tests passed
- `npx tsc --noEmit` -- no type errors across entire project
- Stage router imports all 7 handler functions (verified: 7 imports)
- Stage router imports PipelineJobMessage from `../types.js` -- verified
- Stage router contains `isPipelineJobMessage` type guard -- verified
- Stage router contains `randomUUID` from `node:crypto` -- verified

## Known Stubs

- **approve.ts**: Auto-approve placeholder -- Phase 3 (INTG-01) will replace with Slack-based approval
- **pr.ts**: PR creation placeholder -- Phase 3 (INTG-02) will implement git PR operations

Both stubs are intentional and documented in plan. They return 'completed' status to allow the pipeline to progress end-to-end in v1.

## Threat Surface Scan

All threat model mitigations implemented as specified:
- T-02-12: Dual type guards `isStageMessage()` and `isPipelineJobMessage()` validate all required fields; invalid messages rejected with StageRouterError
- T-02-13: Intake uses parameterized SQL with ON CONFLICT DO NOTHING; runId generated server-side via crypto.randomUUID()
- T-02-14: Execute stage planCount bounded by pipeline context (set by planner); Lambda 15-min timeout is backstop
- T-02-15: StageRouterError includes operation name but no sensitive data

No new threat surface beyond what was documented in the plan's threat model.

## Self-Check: PASSED

- All 9 created files exist on disk
- All 4 task commits verified in git log (99d88c0, c57d557, 41efba1, b5d7b27)

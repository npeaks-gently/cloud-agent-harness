---
phase: 02-pipeline-orchestration-state-management
plan: 01
subsystem: pipeline-types-idempotency
tags: [pipeline, types, idempotency, schema-migration, postgres]
dependency_graph:
  requires: [src/cloud/types.ts, scripts/init-db-schema.sql, src/cloud/postgres-client.ts]
  provides: [src/cloud/pipeline/types.ts, src/cloud/pipeline/idempotency.ts, scripts/migrate-002-idempotency.sql]
  affects: [agent_runs table, pipeline_runs table]
tech_stack:
  added: []
  patterns: [PipelineStage enum, NEXT_STAGE transition map, deterministic task IDs, ON CONFLICT UPSERT]
key_files:
  created:
    - src/cloud/pipeline/types.ts
    - src/cloud/pipeline/idempotency.ts
    - scripts/migrate-002-idempotency.sql
    - src/cloud/test/idempotency.test.ts
  modified: []
decisions:
  - "PipelineError class shared across pipeline modules (not per-module error classes)"
  - "task_key column is nullable to allow existing rows without idempotency keys"
  - "Unique partial index on task_key WHERE task_key IS NOT NULL for idempotency enforcement"
  - "getCompletedTasks uses plan_name LIKE prefix filter for stage-scoped queries"
metrics:
  duration: 2m 46s
  completed: 2026-04-16T05:29:00Z
  tasks_completed: 2
  tasks_total: 2
  files_created: 4
  files_modified: 0
  test_count: 9
  test_pass: 9
---

# Phase 02 Plan 01: Pipeline Types & Idempotency Layer Summary

Pipeline type system with 7-stage enum, inter-stage message contracts, and deterministic task ID idempotency using Postgres ON CONFLICT (task_key) UPSERT pattern.

## What Was Built

### Pipeline Types (`src/cloud/pipeline/types.ts`)
- **PipelineStage enum** with 7 stages: Intake, Research, Plan, Approve, Execute, Verify, PR
- **NEXT_STAGE** constant mapping each stage to its successor (PR -> null terminal)
- **StageMessage** interface for SQS inter-stage message payloads
- **StageResult** and **AgentTaskOutcome** interfaces for stage handler returns
- **AgentRunData** interface for idempotent upsert input
- **PipelineError** class following the shared error pattern (operation + stage context)

### Schema Migration (`scripts/migrate-002-idempotency.sql`)
- `task_key TEXT` column on `agent_runs` for deterministic task IDs
- Unique partial index `idx_agent_runs_task_key` (WHERE task_key IS NOT NULL)
- `current_stage TEXT` on `pipeline_runs` for stage tracking (D-14)
- `repo_url`, `branch`, `feature_description` on `pipeline_runs` for context

### Idempotency Module (`src/cloud/pipeline/idempotency.ts`)
- `buildTaskId()` -- deterministic colon-separated key from runId:phase:plan:wave
- `upsertAgentRun()` -- INSERT ON CONFLICT (task_key) DO UPDATE with started_at preservation
- `getCompletedTasks()` -- query completed task keys with optional stage LIKE filter

### Unit Tests (`src/cloud/test/idempotency.test.ts`)
- 9 tests covering buildTaskId, upsertAgentRun (SQL shape, params, error), getCompletedTasks (with/without stage, error)

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Pipeline types and schema migration | 6b42fd3 | src/cloud/pipeline/types.ts, scripts/migrate-002-idempotency.sql |
| 2 (RED) | Idempotency failing tests | d47b56b | src/cloud/test/idempotency.test.ts |
| 2 (GREEN) | Idempotency implementation | e9dad59 | src/cloud/pipeline/idempotency.ts |

## TDD Gate Compliance

- RED gate: `test(02-01)` commit d47b56b -- 9 tests, all failing (module not found)
- GREEN gate: `feat(02-01)` commit e9dad59 -- 9 tests, all passing
- REFACTOR gate: skipped (no refactoring needed, code follows established patterns)

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

- `npx vitest run src/cloud/test/idempotency.test.ts` -- 9/9 tests passed
- `npx tsc --noEmit src/cloud/pipeline/types.ts` -- no errors
- `scripts/migrate-002-idempotency.sql` -- valid ALTER TABLE and CREATE INDEX statements

## Known Stubs

None -- all types are fully defined, all functions have complete implementations.

## Threat Surface Scan

All SQL queries in idempotency.ts use parameterized queries ($1, $2, etc.) per T-02-01. PipelineError messages include operation name but never parameter values per T-02-02. No new threat surface beyond what was documented in the plan's threat model.

## Self-Check: PASSED

- All 4 created files exist on disk
- All 3 task commits verified in git log (6b42fd3, d47b56b, e9dad59)

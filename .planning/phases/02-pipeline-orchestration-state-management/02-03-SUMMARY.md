---
phase: 02-pipeline-orchestration-state-management
plan: 03
subsystem: checkpoint-resume-sandbox
tags: [checkpoint, resume, sandbox, daytona, snapshot, pipeline-state, postgres]
dependency_graph:
  requires: [src/cloud/pipeline/types.ts, src/cloud/pipeline/idempotency.ts, src/cloud/daytona-client.ts, src/cloud/types.ts, src/cloud/postgres-client.ts]
  provides: [src/cloud/pipeline/checkpoint.ts, src/cloud/pipeline/resume.ts, src/cloud/pipeline/sandbox-task.ts, src/cloud/snapshot/image-builder.ts, src/cloud/snapshot/snapshot-manager.ts]
  affects: [agent_runs table, pipeline_runs table, Daytona snapshot registry]
tech_stack:
  added: []
  patterns: [pipeline checkpoint upsert + UPDATE, stage-level state tracking, pipeline resume from last good stage, CAH_* env var injection, Daytona Image.base() builder, Daytona snapshot service]
key_files:
  created:
    - src/cloud/pipeline/checkpoint.ts
    - src/cloud/pipeline/resume.ts
    - src/cloud/pipeline/sandbox-task.ts
    - src/cloud/snapshot/image-builder.ts
    - src/cloud/snapshot/snapshot-manager.ts
    - src/cloud/test/checkpoint.test.ts
    - src/cloud/test/resume.test.ts
  modified: []
decisions:
  - "checkpoint.ts uses two-step write: upsertAgentRun for status, then UPDATE for outcome details (cost, duration, artifacts)"
  - "getPipelineState combines pipeline_runs query with getCompletedTasks for a unified state view"
  - "resumePipeline casts currentStage string back to PipelineStage enum for type safety"
  - "sandbox-task.ts parses last stdout line as JSON for agent result extraction (T-02-09 fallback on parse failure)"
  - "ANTHROPIC_API_KEY injected from Lambda process.env into sandbox (T-02-08: never logged, ephemeral sandbox)"
  - "Image builder uses node:22-slim base with git+curl system deps and npm ci --production"
  - "Snapshot name fixed to 'cah-harness-v1' with 300s creation timeout (T-02-11)"
metrics:
  duration: 3m 43s
  completed: 2026-04-16T05:40:38Z
  tasks_completed: 2
  tasks_total: 2
  files_created: 7
  files_modified: 0
  test_count: 13
  test_pass: 13
---

# Phase 02 Plan 03: Checkpoint/Resume & Sandbox Integration Summary

Checkpoint/resume system with Postgres-backed pipeline state persistence, and Daytona sandbox integration layer with declarative Image builder and snapshot management for fault-tolerant pipeline execution.

## What Was Built

### Checkpoint Module (`src/cloud/pipeline/checkpoint.ts`)
- **writeAgentCheckpoint** -- two-step write: upserts agent_run via idempotency module (sets status to completed/failed), then UPDATE with cost_usd, duration_ms, artifacts JSON, error_message, and completed_at timestamp
- **updatePipelineStage** -- updates pipeline_runs SET current_stage and status; null stage means pipeline completed (all stages done, PR delivered)
- **getPipelineState** -- reads current_stage and status from pipeline_runs, combines with getCompletedTasks to return unified state view

### Resume Module (`src/cloud/pipeline/resume.ts`)
- **resumePipeline** -- queries pipeline state via getPipelineState, returns the stage to resume from and completed task keys to skip; throws PipelineError if run not found; returns Intake for new/pending runs

### Sandbox Task Wrapper (`src/cloud/pipeline/sandbox-task.ts`)
- **runAgentTask** -- wraps DaytonaClient.executeTask() with pipeline context injection (CAH_RUN_ID, CAH_STAGE, CAH_PHASE, CAH_PLAN, CAH_BUCKET, CAH_REPO_URL, CAH_BRANCH, ANTHROPIC_API_KEY)
- Builds deterministic taskKey via buildTaskId(), writes checkpoint on success and failure
- Parses last stdout line as JSON for agent result extraction; falls back to exit code on parse failure

### Image Builder (`src/cloud/snapshot/image-builder.ts`)
- **buildHarnessImage** -- declarative Daytona Image via Image.base('node:22-slim') builder chain
- Installs git + curl, copies sdk/agents/commands/get-shit-done directories, runs npm ci --production, adds entrypoint script, sets NODE_ENV=production

### Snapshot Manager (`src/cloud/snapshot/snapshot-manager.ts`)
- **createOrUpdateSnapshot** -- registers harness Image as Daytona snapshot named 'cah-harness-v1' with 300s timeout
- **getSnapshotName** -- returns the fixed snapshot name for sandbox creation references

### Unit Tests
- **checkpoint.test.ts** -- 10 tests: writeAgentCheckpoint (upsert status, UPDATE query, error), updatePipelineStage (with stage, null, error), getPipelineState (full state, null, error)
- **resume.test.ts** -- 3 tests: partial completion resume, new run returns Intake, missing run throws PipelineError

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Checkpoint + resume failing tests | 4585238 | src/cloud/test/checkpoint.test.ts, src/cloud/test/resume.test.ts |
| 1 (GREEN) | Checkpoint + resume implementation | da22630 | src/cloud/pipeline/checkpoint.ts, src/cloud/pipeline/resume.ts |
| 2 | Sandbox task, image builder, snapshot manager | 14c83bc | src/cloud/pipeline/sandbox-task.ts, src/cloud/snapshot/image-builder.ts, src/cloud/snapshot/snapshot-manager.ts |

## TDD Gate Compliance

- RED gate: `test(02-03)` commit 4585238 -- 13 tests, all failing (modules not found)
- GREEN gate: `feat(02-03)` commit da22630 -- 13 tests, all passing
- REFACTOR gate: skipped (code follows established patterns, no cleanup needed)

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

- `npx vitest run src/cloud/test/checkpoint.test.ts src/cloud/test/resume.test.ts` -- 13/13 tests passed
- `npx tsc --noEmit src/cloud/pipeline/sandbox-task.ts` -- no type errors
- `npx tsc --noEmit src/cloud/snapshot/image-builder.ts` -- no type errors
- checkpoint.ts imports from idempotency.ts (upsertAgentRun, getCompletedTasks) -- verified
- resume.ts imports from checkpoint.ts (getPipelineState) -- verified
- sandbox-task.ts imports from both daytona-client.ts and checkpoint.ts -- verified

## Known Stubs

None -- all functions have complete implementations, all types fully defined.

## Threat Surface Scan

All threat model mitigations implemented as specified:
- T-02-08: ANTHROPIC_API_KEY read from process.env, never logged, scoped per ephemeral sandbox invocation
- T-02-09: JSON parse of stdout wrapped in try/catch with fallback to default values; malformed stdout does not crash the orchestrator
- T-02-10: Using official node:22-slim base image (accepted risk, Daytona sandbox isolation)
- T-02-11: Snapshot creation has 300-second timeout; unresponsive Daytona API fails cleanly

No new threat surface beyond what was documented in the plan's threat model.

## Self-Check: PASSED

- All 7 created files exist on disk
- All 3 task commits verified in git log (4585238, da22630, 14c83bc)

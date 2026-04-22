---
phase: "03"
plan: "03"
subsystem: pipeline-stages
tags: [slack-approval, github-pr, linear-tickets, stage-router, posthog, merge-executor]
dependency_graph:
  requires: [03-01, 03-02]
  provides: [approve-stage-slack, intake-branch-ticket, pr-stage-github, merge-executor, paused-handling, d10-sub-tickets]
  affects: [stage-router, approve, intake, pr]
tech_stack:
  added: []
  patterns: [paused-status-handling, sub-ticket-lifecycle, repo-url-parsing, branch-merge-abort]
key_files:
  created:
    - src/cloud/pipeline/merge-executor.ts
    - src/cloud/test/approve.test.ts
    - src/cloud/test/intake-intg.test.ts
    - src/cloud/test/pr.test.ts
    - src/cloud/test/merge-executor.test.ts
  modified:
    - src/cloud/pipeline/stages/approve.ts
    - src/cloud/pipeline/stages/intake.ts
    - src/cloud/pipeline/stages/pr.ts
    - src/cloud/pipeline/stage-router.ts
    - src/cloud/test/stage-router.test.ts
decisions:
  - "Linear sub-ticket creation is non-critical -- wrapped in try/catch, pipeline continues if Linear is down"
  - "PR stage Linear operations (attachPrUrl, updateTicketStatus) are non-critical -- logged as warnings on failure"
  - "parseRepoUrl duplicated in intake.ts and pr.ts rather than extracting to shared util (localized to each stage)"
metrics:
  duration: "6m"
  completed: "2026-04-16T18:39:54Z"
  tasks_completed: 3
  tasks_total: 3
  tests_added: 31
  tests_total: 53
---

# Phase 03 Plan 03: Pipeline Stage Integration Wiring Summary

Replaced approve, intake, and PR stage placeholders with real Slack approval flow, GitHub branch/PR creation, and Linear ticket lifecycle; added paused handling and D-10 sub-ticket lifecycle to stage router with PostHog tracking.

## Task Summary

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Approve stage + paused handling + D-10 sub-tickets | 23dcf42 | approve.ts, stage-router.ts, approve.test.ts, stage-router.test.ts |
| 2 | Intake stage feature branch + Linear ticket | 4224943 | intake.ts, intake-intg.test.ts |
| 3 | PR stage + merge executor | a5cd97c | pr.ts, merge-executor.ts, pr.test.ts, merge-executor.test.ts |

## What Changed

### Approve Stage (D-01, D-04)
- Replaced auto-approve placeholder with real Slack approval flow
- Generates UUID v4 approval token via crypto.randomUUID() (T-03-09)
- Sends Block Kit approval message to Slack channel via sendApprovalMessage
- Persists approval token to Postgres via insertApproval
- Returns `status: 'paused'` so pipeline waits for Slack webhook resolution
- CloudWatch log includes runId and token but NOT message content (T-03-11)

### Stage Router Enhancements
- **Paused handling (D-03):** New `else if (result.status === 'paused')` branch updates pipeline_runs to 'paused' without SQS advance
- **D-10 sub-ticket creation:** Before execute stage handler, creates Linear sub-ticket linked to parent and sets to 'in_progress'
- **D-10 status updates:** At successful stage transitions, updates Linear parent ticket status to 'in_progress'
- **PostHog tracking (D-14):** Calls `track('stage_completed', ...)` after every handler return
- **Flush:** Calls `flush()` before returning to prevent PostHog event loss in Lambda

### Intake Stage (D-05, D-09)
- Creates feature branch on GitHub: `cah/{shortRunId}/{featureSlug}` format
- Creates parent Linear ticket via createParentTicket
- Records both in pipeline_runs via updatePipelineRunBranch and updatePipelineRunLinearTicket
- Enriches msg.context.featureBranch and msg.context.linearParentTicketId for downstream stages
- Tracks 'pipeline_started' event in PostHog

### PR Stage (D-08, D-11)
- Creates pull request from feature branch to base branch via createPullRequest
- PR title: `[CAH] {featureDescription}`, body includes run metadata
- Attaches PR URL to Linear parent ticket via attachPrUrl (D-11)
- Marks Linear parent ticket as 'done' via updateTicketStatus (D-11)
- Tracks 'pr_created' event in PostHog (T-03-14)
- Throws PipelineError if featureBranch missing from context

### Merge Executor (D-07)
- New module: mergeTaskBranches() sequentially merges task branches into feature branch
- Uses `git merge --no-ff` for explicit merge commits
- MergeError on conflict with automatic `git merge --abort` recovery (T-03-12)
- Returns list of successfully merged branches

## Test Coverage

| Test File | Tests | Status |
|-----------|-------|--------|
| approve.test.ts | 8 | All pass |
| stage-router.test.ts | 27 (20 existing + 7 new) | All pass |
| intake-intg.test.ts | 11 | All pass |
| pr.test.ts | 10 | All pass |
| merge-executor.test.ts | 5 | All pass |
| **Total** | **53** (31 new) | **All pass** |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed vi.mock paths in approve.test.ts**
- **Found during:** Task 1
- **Issue:** vi.mock paths were relative to the source module (`../../integrations/slack.js`) instead of relative to the test file
- **Fix:** Changed to paths relative to the test file location (`../integrations/slack.js`, `../postgres-client.js`, `../analytics.js`)
- **Files modified:** src/cloud/test/approve.test.ts
- **Commit:** 23dcf42

**2. [Rule 1 - Bug] Fixed double-invocation in error assertion tests**
- **Found during:** Task 1
- **Issue:** Tests called handleApproveStage twice in error assertions (first consumed the mock rejection, second hit the real code path)
- **Fix:** Changed to try/catch pattern for single-invocation error assertions
- **Files modified:** src/cloud/test/approve.test.ts
- **Commit:** 23dcf42

## Decisions Made

1. **Non-critical Linear operations:** Sub-ticket creation at execute entry and status updates at stage transitions are wrapped in try/catch -- pipeline continues if Linear is unavailable (T-03-15a)
2. **PR stage Linear failure handling:** attachPrUrl and updateTicketStatus failures are logged as warnings but do not fail the PR stage
3. **parseRepoUrl duplication:** The helper is duplicated in intake.ts (exported for testing) and pr.ts (private) rather than extracting to a shared utility. Both stages need it and it is small enough that duplication is acceptable for v1.

## Self-Check: PASSED

- All 11 key files verified present on disk
- All 3 task commits verified in git log (23dcf42, 4224943, a5cd97c)
- TypeScript: `npx tsc --noEmit` exits 0
- Tests: All 53 tests pass across 5 test files

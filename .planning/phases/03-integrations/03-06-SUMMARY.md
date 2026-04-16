---
phase: "03-integrations"
plan: "06"
subsystem: "analytics"
tags: [posthog, token-usage, gap-closure, observability]
dependency_graph:
  requires: []
  provides: ["token-usage-in-posthog-events"]
  affects: ["agent-entrypoint"]
tech_stack:
  added: []
  patterns: ["safe-fallback-nullish-coalescing"]
key_files:
  created: []
  modified:
    - src/cloud/entrypoint/agent-entrypoint.ts
    - src/cloud/test/entrypoint.test.ts
decisions:
  - "Used nullish coalescing (??) with zero-value fallback object for result.usage to handle edge cases where SDK returns undefined usage"
metrics:
  duration: "73s"
  completed: "2026-04-16T19:17:37Z"
  tasks_completed: 1
  tasks_total: 1
---

# Phase 03 Plan 06: Token Usage in PostHog Events Summary

Token usage fields (inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens) added to agent_run_completed PostHog event from SDK PlanResult.usage, closing the INTG-04 verification gap.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add token usage to agent_run_completed PostHog event and update test | f337364 | src/cloud/entrypoint/agent-entrypoint.ts, src/cloud/test/entrypoint.test.ts |

## Changes Made

### Task 1: Add token usage to agent_run_completed PostHog event and update test

**In `src/cloud/entrypoint/agent-entrypoint.ts`:**
- Extracted `usage` from `result.usage` with a safe zero-value fallback using nullish coalescing (`??`)
- Added four token usage properties to the `track('agent_run_completed', ...)` call: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`

**In `src/cloud/test/entrypoint.test.ts`:**
- Updated default `mockExecutePlan` return value to include a `usage` object with realistic token counts
- Updated the "tracks agent_run_completed event with cost data" assertion to verify all four token usage fields
- Added new test: "uses zero-value token usage when result.usage is undefined" to verify the safe fallback path
- Updated the "skips push when execution fails" mock to include usage data for consistency

## Verification Results

- `npx vitest run src/cloud/test/entrypoint.test.ts` -- 21 tests passed, 0 failures
- `grep -n 'inputTokens' src/cloud/entrypoint/agent-entrypoint.ts` -- token fields confirmed in track() call
- `grep -n 'cacheReadInputTokens' src/cloud/entrypoint/agent-entrypoint.ts` -- cache token fields confirmed
- `npx tsc --noEmit` -- TypeScript compiles cleanly with no errors

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all token usage fields are wired to real SDK data via `result.usage`.

## Decisions Made

1. **Zero-value fallback pattern**: Used `result.usage ?? { inputTokens: 0, ... }` rather than optional chaining on each field. This keeps the track() call clean and ensures all four fields are always present in the PostHog event, even if the SDK returns undefined usage (e.g., older SDK version or error path).

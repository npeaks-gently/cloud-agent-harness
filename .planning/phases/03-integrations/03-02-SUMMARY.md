---
phase: 03-integrations
plan: 02
subsystem: integrations
tags: [slack, github, linear, sdk-wrapper, secrets-manager]
dependency_graph:
  requires: []
  provides: [slack-approval-message, github-pr-creation, github-branch-creation, linear-ticket-crud]
  affects: [approve-stage, intake-stage, pr-stage, execute-stage]
tech_stack:
  added: ["@slack/web-api", "@octokit/rest", "@linear/sdk"]
  patterns: [secrets-manager-cache, error-class-per-module, cloudwatch-structured-logging, block-kit-approval]
key_files:
  created:
    - src/cloud/integrations/slack.ts
    - src/cloud/integrations/github.ts
    - src/cloud/integrations/linear.ts
    - src/cloud/test/slack-client.test.ts
    - src/cloud/test/github-client.test.ts
    - src/cloud/test/linear-client.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "Linear issue payload uses async .issue accessor (SDK returns IssuePayload with promise)"
  - "Added _resetTokenCache() internal export on all three modules for test isolation"
  - "updateTicketStatus validates statusKey against LINEAR_STATE_MAP before calling API"
metrics:
  duration: 4m
  completed: "2026-04-16T18:28:00Z"
---

# Phase 03 Plan 02: Integration Utility Modules Summary

Thin SDK wrappers for Slack (Block Kit approval), GitHub (branch + PR), and Linear (ticket CRUD) with Secrets Manager cold-start caching and per-module error classes.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Install SDKs and create Slack + GitHub utilities with tests | 89dc103 | slack.ts, github.ts, slack-client.test.ts, github-client.test.ts |
| 2 | Create Linear integration utility with tests | e75db5c | linear.ts, linear-client.test.ts |

## What Was Built

### Slack Integration (`src/cloud/integrations/slack.ts`)
- `SlackClientError` extends Error with operation and channel context
- `getSlackBotToken()` fetches from Secrets Manager via SLACK_BOT_TOKEN_SECRET_ARN, caches at cold start
- `sendApprovalMessage()` sends Block Kit message with header, plan summary section, and actions block containing primary "Approve" (`pipeline_approve`) and danger "Reject" (`pipeline_reject`) buttons (D-04)

### GitHub Integration (`src/cloud/integrations/github.ts`)
- `GitHubClientError` extends Error with operation and repo context
- `getGitHubToken()` fetches from Secrets Manager via CAH_GITHUB_TOKEN_SECRET_ARN, caches at cold start
- `createFeatureBranch()` gets base SHA via `git.getRef` then creates new ref via `git.createRef` (D-05)
- `createPullRequest()` opens PR via `pulls.create`, returns `{ url, number }` (D-08)

### Linear Integration (`src/cloud/integrations/linear.ts`)
- `LinearClientError` extends Error with operation and issueId context
- `getLinearApiKey()` fetches from Secrets Manager via LINEAR_API_KEY_SECRET_ARN, caches at cold start
- `getLinearConfig()` reads LINEAR_TEAM_ID and LINEAR_STATE_MAP from environment
- `createParentTicket()` creates [CAH]-prefixed issue with pipeline run context (D-09)
- `createSubTicket()` creates phase issue linked via parentId (D-10)
- `updateTicketStatus()` maps status key to state UUID from LINEAR_STATE_MAP, validates key exists
- `attachPrUrl()` creates attachment with PR URL on ticket (D-11)

### Test Coverage
- 29 tests across 3 test files, all passing
- Tests follow vi.hoisted() + vi.mock() pattern from existing stage-router.test.ts
- Each module's Secrets Manager caching is verified (call twice, assert mockSend called once)
- Error paths verified with custom error class instanceof checks

## Patterns Followed

All three utilities follow identical patterns established by existing code:
1. **Error class** per module (matches DaytonaClientError pattern from daytona-client.ts)
2. **Secrets Manager cold-start cache** (matches getAnthropicApiKey pattern from sandbox-task.ts)
3. **try/catch wrapping** SDK calls with typed error re-throw
4. **CloudWatch structured logging** with JSON.stringify (matches approve.ts pattern)
5. **Section dividers** with `// ---` horizontal rules (matches codebase convention)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added _resetTokenCache() internal exports**
- **Found during:** Task 1
- **Issue:** Module-scoped token caches persist across test runs, causing flaky test behavior
- **Fix:** Added `_resetTokenCache()` function on all three modules, called in `beforeEach`
- **Files modified:** slack.ts, github.ts, linear.ts

**2. [Rule 2 - Input validation] Added statusKey validation in updateTicketStatus**
- **Found during:** Task 2
- **Issue:** Passing an unknown statusKey to updateTicketStatus would result in `undefined` stateId being sent to Linear API
- **Fix:** Check if statusKey exists in states map before calling API; throw descriptive LinearClientError if missing
- **Files modified:** linear.ts

## Threat Surface Scan

No new threat surface beyond what the plan's threat model already covers. All three utilities:
- Fetch API keys from Secrets Manager (T-03-05: never logged, operation name only in errors)
- Use module-scoped caching (T-03-05: not stored as plaintext env vars)
- Wrap SDK calls in try/catch with typed error propagation (T-03-08: graceful failure)

## Known Stubs

None -- all functions are fully wired to their respective SDK clients with real API call patterns.

## Self-Check: PASSED

- All 7 created files exist on disk
- Both task commits (89dc103, e75db5c) exist in git log
- 29/29 tests pass across 3 test files
- TypeScript compilation passes (tsc --noEmit exits 0)

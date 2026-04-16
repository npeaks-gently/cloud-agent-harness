---
phase: 03-integrations
verified: 2026-04-16T15:05:00Z
status: gaps_found
score: 3/4 must-haves verified
overrides_applied: 0
gaps:
  - truth: "PostHog receives events for agent runs, token usage, cost accrual, pipeline status changes, and phase transitions"
    status: partial
    reason: "PostHog events are sent for agent_run_completed (cost), stage_completed (status/transitions), pipeline_started, pr_created, approval_requested/approved/rejected. However, token usage (inputTokens, outputTokens) is NOT included in the agent_run_completed event. The SDK PlanResult.usage has inputTokens/outputTokens available but they are not passed to track(). INTG-04 and SC-4 explicitly require token usage in PostHog."
    artifacts:
      - path: "src/cloud/entrypoint/agent-entrypoint.ts"
        issue: "track('agent_run_completed', { runId, phase, plan, wave, costUsd, success, projectId }) — result.usage.inputTokens and result.usage.outputTokens are available from executePlan() but not forwarded to track()"
    missing:
      - "Add result.usage.inputTokens and result.usage.outputTokens (or result.usage itself) to the agent_run_completed track() call in the execute stage"
---

# Phase 3: Integrations Verification Report

**Phase Goal:** The pipeline connects to external systems -- users approve plans in Slack, completed work lands as a GitHub PR, Linear tickets track status, and PostHog captures pipeline events
**Verified:** 2026-04-16T15:05:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A Slack message with Block Kit approve/reject buttons is sent when the pipeline reaches the approval gate, and clicking approve resumes the pipeline execution via SQS re-enqueue | VERIFIED | `approve.ts` sends Block Kit via `sendApprovalMessage()` with `pipeline_approve`/`pipeline_reject` buttons, writes token to Postgres, returns `'paused'`. Stage router handles `paused` without SQS advance. `slack-handler.ts` verifies HMAC-SHA256 signature, validates token, resolves approval, and sends SQS `SendMessageCommand` for Execute stage on approval. 15 webhook tests pass. |
| 2 | The pipeline creates a feature branch, makes atomic commits per task, and opens a PR with a structured description as its final output | VERIFIED | `intake.ts` calls `createFeatureBranch()` (format: `cah/{runId8}/{slug}`) and records in pipeline_runs. `agent-entrypoint.ts` calls `createTaskBranch()`, `commitAndPush()` via `git push origin`. `pr.ts` calls `createPullRequest()` with `[CAH]` title and structured body. All wired through GitHub integration utility. |
| 3 | Linear ticket status updates at each pipeline phase transition, and the completed PR URL is linked back to the originating Linear ticket | VERIFIED | `intake.ts` creates parent ticket via `createParentTicket()`. Stage router calls `createSubTicket()` at execute entry and `updateTicketStatus()` at transitions. `pr.ts` calls `attachPrUrl()` and `updateTicketStatus('done')` on PR creation. All backed by Linear integration tests. |
| 4 | PostHog receives events for agent runs, token usage, cost accrual, pipeline status changes, and phase transitions | PARTIAL — FAILED | Events sent: `pipeline_started` (intake), `approval_requested`/`approval_approved`/`approval_rejected` (approve/webhook), `stage_completed` with status (stage-router), `agent_run_completed` with costUsd (entrypoint), `pr_created` (pr stage). Cost accrual: YES. Pipeline status/transitions: YES. Agent runs: YES. Token usage: MISSING — `result.usage.inputTokens` and `result.usage.outputTokens` are available from `executePlan()` return value but are not included in the `agent_run_completed` `track()` call. INTG-04 and SC-4 explicitly list "token usage" as required. |

**Score:** 3/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/cloud/pipeline/types.ts` | Extended StageResult with 'paused', StageMessage.context with featureBranch/linearParentTicketId | VERIFIED | `status: 'completed' | 'failed' | 'skipped' | 'paused'` at line 103; `featureBranch?: string` and `linearParentTicketId?: string` at lines 85-87 |
| `scripts/migrate-003-approvals.sql` | Approvals table and pipeline_runs extensions | VERIFIED | `CREATE TABLE IF NOT EXISTS approvals` with all required columns; `ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS feature_branch TEXT` and `linear_parent_ticket_id TEXT` |
| `src/cloud/postgres-client.ts` | Approval CRUD and pipeline run update functions | VERIFIED | All 5 functions exported: `insertApproval`, `getApprovalByToken`, `resolveApproval`, `updatePipelineRunBranch`, `updatePipelineRunLinearTicket` |
| `src/cloud/analytics.ts` | PostHog thin utility with track and flush | VERIFIED | `export function track(` at line 38, `export async function flush(` at line 56, `import { PostHog } from 'posthog-node'`, `flushAt: 1`, `flushInterval: 0` |
| `src/cloud/test/analytics.test.ts` | PostHog utility unit tests | VERIFIED | 6 test cases |
| `src/cloud/integrations/slack.ts` | Slack Web API wrapper | VERIFIED | `SlackClientError`, `getSlackBotToken`, `sendApprovalMessage` with `pipeline_approve`/`pipeline_reject` action IDs |
| `src/cloud/integrations/github.ts` | GitHub API wrapper | VERIFIED | `GitHubClientError`, `getGitHubToken`, `createFeatureBranch`, `createPullRequest` using `pulls.create` |
| `src/cloud/integrations/linear.ts` | Linear SDK wrapper with ticket CRUD | VERIFIED | `LinearClientError`, `getLinearApiKey`, `createParentTicket`, `createSubTicket` (with `parentId`), `updateTicketStatus`, `attachPrUrl` |
| `src/cloud/test/slack-client.test.ts` | Slack utility unit tests | VERIFIED | 8 test cases |
| `src/cloud/test/github-client.test.ts` | GitHub utility unit tests | VERIFIED | 7 test cases |
| `src/cloud/test/linear-client.test.ts` | Linear utility unit tests | VERIFIED | 14 test cases |
| `src/cloud/pipeline/stages/approve.ts` | Slack approval + Postgres token write + 'paused' return | VERIFIED | Imports `sendApprovalMessage` and `insertApproval`; returns `status: 'paused'`; uses `randomUUID()` for token |
| `src/cloud/pipeline/stage-router.ts` | Paused status handling, D-10 sub-ticket lifecycle, PostHog tracking | VERIFIED | `result.status === 'paused'` branch with `status = 'paused'` SQL; `createSubTicket` at execute entry; `updateTicketStatus` at transitions; `track('stage_completed')` and `flush()` |
| `src/cloud/pipeline/stages/intake.ts` | Feature branch + Linear parent ticket creation | VERIFIED | `createFeatureBranch`, `createParentTicket`, `updatePipelineRunBranch`, `updatePipelineRunLinearTicket`, `msg.context.featureBranch =`, `msg.context.linearParentTicketId =` |
| `src/cloud/pipeline/stages/pr.ts` | PR creation with Linear link-back | VERIFIED | `createPullRequest`, `attachPrUrl`, `[CAH]` title |
| `src/cloud/pipeline/merge-executor.ts` | Git merge with conflict abort | VERIFIED | `export async function mergeTaskBranches(`, `export class MergeError`, `git merge --abort` |
| `src/cloud/entrypoint/agent-entrypoint.ts` | Git push + PostHog agent_run_completed tracking | PARTIAL | `configureGitAuth`, `createTaskBranch`, `commitAndPush`, `git push origin`, `track('agent_run_completed', { costUsd, ... })`, `flush()` — all present. Token usage (`inputTokens`/`outputTokens`) missing from track() properties. |
| `infra/lib/constructs/slack-webhook.ts` | CDK construct for API Gateway + webhook Lambda | VERIFIED | `CahSlackWebhookProps`, `CahSlackWebhook extends Construct`, `api: apigw.HttpApi`, `webhookFn: lambda.Function`, `/slack/actions` route, `sqs:SendMessage` and `secretsmanager:GetSecretValue` IAM |
| `infra/lib/cah-stack.ts` | Stack wiring for webhook construct | VERIFIED | `import { CahSlackWebhook }`, `new CahSlackWebhook(`, `SlackWebhookUrl` CfnOutput, `cah-dev-slack-signing-secret`, `cah-dev-slack-bot-token` |
| `infra/lambda/slack-webhook/index.js` | Placeholder Lambda handler for CDK synthesis | VERIFIED | Exists as known intentional placeholder; actual handler in `slack-handler.ts` |
| `src/cloud/webhook/slack-handler.ts` | Lambda handler for Slack interactive payloads | VERIFIED | `verifySlackSignature` with `timingSafeEqual`, `createHmac('sha256')`, `5 * 60` replay protection, `handleSlackAction`, `getApprovalByToken`, `resolveApproval`, `SendMessageCommand`, `WebhookHandlerError` |
| `src/cloud/test/approve.test.ts` | Approve stage unit tests | VERIFIED | 8 test cases |
| `src/cloud/test/intake-intg.test.ts` | Intake stage integration tests | VERIFIED | 11 test cases |
| `src/cloud/test/pr.test.ts` | PR stage tests | VERIFIED | 10 test cases |
| `src/cloud/test/merge-executor.test.ts` | Merge executor tests | VERIFIED | 5 test cases |
| `src/cloud/test/entrypoint.test.ts` | Agent entrypoint tests | VERIFIED | 21 test cases |
| `src/cloud/test/slack-webhook.test.ts` | Webhook handler tests | VERIFIED | 15 test cases |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/cloud/pipeline/stages/approve.ts` | `src/cloud/integrations/slack.ts` | `sendApprovalMessage` import | WIRED | Import at line 17, called at line 60 |
| `src/cloud/pipeline/stages/approve.ts` | `src/cloud/postgres-client.ts` | `insertApproval` import | WIRED | Import at line 18, called at line 71 |
| `src/cloud/pipeline/stage-router.ts` | `src/cloud/integrations/linear.ts` | `createSubTicket` and `updateTicketStatus` imports | WIRED | Import at line 30, `createSubTicket` called at line 213, `updateTicketStatus` called at lines 219, 272 |
| `src/cloud/pipeline/stages/intake.ts` | `src/cloud/integrations/github.ts` | `createFeatureBranch` import | WIRED | Import at line 16, called at line 122 |
| `src/cloud/pipeline/stage-router.ts` | `src/cloud/analytics.ts` | `track` and `flush` imports | WIRED | Import at line 29, `track` at line 243, `flush` at line 306 |
| `src/cloud/webhook/slack-handler.ts` | `src/cloud/postgres-client.ts` | `getApprovalByToken` and `resolveApproval` | WIRED | Import at line 24, called at lines 163 and 174 |
| `src/cloud/webhook/slack-handler.ts` | `@aws-sdk/client-sqs` | `SendMessageCommand` for pipeline resume | WIRED | Import at line 19, called at line 218 |
| `src/cloud/webhook/slack-handler.ts` | `node:crypto` | `timingSafeEqual` for HMAC verification | WIRED | Import at line 18, used at line 89 |
| `infra/lib/cah-stack.ts` | `infra/lib/constructs/slack-webhook.ts` | `new CahSlackWebhook` construct instantiation | WIRED | Import at line 19, instantiated at line 106 |
| `src/cloud/entrypoint/agent-entrypoint.ts` | git remote | `execSync git push` | WIRED | `git push origin ${taskBranch}` at line 175 |
| `src/cloud/entrypoint/agent-entrypoint.ts` | `src/cloud/analytics.ts` | `track` and `flush` imports | WIRED | Import at line 21, `track('agent_run_completed')` at line 239, `flush()` at line 255 |
| `src/cloud/integrations/slack.ts` | `@slack/web-api` | `WebClient.chat.postMessage` | WIRED | `chat.postMessage` present in slack.ts |
| `src/cloud/integrations/github.ts` | `@octokit/rest` | `Octokit.rest.pulls.create` | WIRED | `pulls.create` at line 157 |
| `src/cloud/integrations/linear.ts` | `@linear/sdk` | `LinearClient.createIssue` | WIRED | `createIssue` at line 116 with `parentId` for sub-tickets |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `approve.ts` | `token`, `messageTs` | `randomUUID()` + `sendApprovalMessage()` + `insertApproval()` | Yes — UUID token written to Postgres approvals table | FLOWING |
| `slack-handler.ts` | `approval` | `getApprovalByToken(pool, token)` — parameterized SQL | Yes — real Postgres query, returns null for unknown tokens | FLOWING |
| `stage-router.ts` | `result.status === 'paused'` | Handler return from `handleApproveStage` | Yes — approve handler returns real 'paused' status | FLOWING |
| `intake.ts` | `featureBranch`, `linearParentTicketId` | `createFeatureBranch()` + `createParentTicket()` then `msg.context.*` assignment | Yes — branch created on GitHub, ticket created on Linear, IDs stored in Postgres and propagated in SQS context | FLOWING |
| `entrypoint.ts` | `costUsd` | `result.totalCostUsd ?? 0` from `executePlan()` | Yes — SDK returns real cost from API usage | FLOWING |
| `entrypoint.ts` | token usage | `result.usage.inputTokens/outputTokens` | Available in SDK result but NOT forwarded to PostHog | HOLLOW_PROP |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 193 cloud unit tests pass | `npx vitest run --project cloud-unit` | 193 passed (19 files, 0 failures) | PASS |
| TypeScript compiles cleanly | `npx tsc --noEmit` | Exit 0, no errors | PASS |
| verifySlackSignature exported function exists | `grep "export function verifySlackSignature"` | Found at slack-handler.ts:75 | PASS |
| Paused status SQL update correct | `grep "status = 'paused'"` | Found in stage-router.ts:261 | PASS |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| INTG-01 | 03-01, 03-02, 03-03, 03-04, 03-05 | Slack approval workflow with Block Kit approve/reject buttons for plan approval | SATISFIED | Approve stage sends Block Kit message, webhook handler verifies signatures and validates tokens, SQS re-enqueue on approval, 'paused' status gates pipeline advance |
| INTG-02 | 03-02, 03-03, 03-04 | Git integration and PR delivery (branch creation, atomic commits per task, PR with structured description) | SATISFIED | Feature branch created at intake, task branches created per agent execution in entrypoint with `git push`, PR created with `[CAH]` structured description |
| INTG-03 | 03-02, 03-03 | Linear integration with pipeline status updates on ticket and PR link-back on completion | SATISFIED | Parent ticket created at intake, sub-tickets at execute entry, status updates at transitions, PR URL attached and ticket marked 'done' at PR stage |
| INTG-04 | 03-01, 03-03, 03-04 | PostHog event tracking for agent runs, token usage, cost, pipeline status, and phase transitions | PARTIAL | Events: `pipeline_started`, `stage_completed`, `agent_run_completed` (with costUsd), `pr_created`, `approval_requested/approved/rejected`. Missing: token usage (inputTokens/outputTokens) in `agent_run_completed` event |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `infra/lambda/slack-webhook/index.js` | Placeholder Lambda handler | Info | Intentional — CDK synthesis requires a physical file; actual handler is `src/cloud/webhook/slack-handler.ts`. Does not block goal. |
| `src/cloud/entrypoint/agent-entrypoint.ts` | `result.usage` not forwarded to PostHog | Warning | `agent_run_completed` tracks `costUsd` but omits `inputTokens`/`outputTokens` despite INTG-04 requirement |

### Human Verification Required

None — all behaviors are verifiable programmatically.

### Gaps Summary

**1 gap blocks full goal achievement:**

**Token usage missing from PostHog `agent_run_completed` event (INTG-04 partial).**

The `executePlan()` return value provides `result.usage` containing `inputTokens`, `outputTokens`, `cacheReadInputTokens`, and `cacheCreationInputTokens`. These are not included in the `track('agent_run_completed', { ... })` call in `src/cloud/entrypoint/agent-entrypoint.ts`. The ROADMAP SC-4 and INTG-04 requirement both explicitly list "token usage" as a required PostHog event property.

Fix: Add `inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens` (and optionally cacheReadInputTokens/cacheCreationInputTokens) to the `track('agent_run_completed', { ... })` properties block, then update the corresponding test.

All other phase deliverables — Slack approval flow end-to-end, GitHub PR delivery, Linear ticket lifecycle, CDK webhook infrastructure, and all other PostHog events — are fully implemented, tested, and wired.

---

_Verified: 2026-04-16T15:05:00Z_
_Verifier: Claude (gsd-verifier)_

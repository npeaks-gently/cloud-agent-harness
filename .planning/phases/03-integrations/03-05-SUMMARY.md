---
phase: "03"
plan: "05"
subsystem: webhook
tags: [slack-webhook, hmac-sha256, sqs-resume, approval-flow, replay-protection]
dependency_graph:
  requires: [03-03, 03-04]
  provides: [slack-webhook-handler, signature-verification, approval-resolution, pipeline-resume]
  affects: [pipeline-lifecycle, slack-approval-flow]
tech_stack:
  added: []
  patterns: [hmac-signature-verification, timing-safe-comparison, url-encoded-payload-parsing, secrets-manager-caching]
key_files:
  created:
    - src/cloud/webhook/slack-handler.ts
    - src/cloud/test/slack-webhook.test.ts
  modified: []
decisions:
  - "Pipeline run config JSONB column used to reconstruct StageMessage fields (repoUrl, branch, featureDescription, featureBranch, linearParentTicketId) rather than adding direct SQL query"
  - "Lambda entry point creates and closes pool per invocation for simplicity; warm-start optimization deferred"
  - "Signing secret cached at module level for Lambda warm starts via SecretsManagerClient"
metrics:
  duration: "2m 32s"
  completed: "2026-04-16T18:47:16Z"
  tasks_completed: 1
  tasks_total: 1
  tests_added: 15
  tests_total: 15
---

# Phase 03 Plan 05: Slack Webhook Handler Summary

Slack interactive payload Lambda handler with HMAC-SHA256 signature verification, 5-minute replay protection, Postgres token validation, and SQS pipeline resume on approval.

## What Was Built

### Slack Webhook Handler (`src/cloud/webhook/slack-handler.ts`)

Lambda handler that receives Slack interactive payloads when users click Approve or Reject buttons in Slack messages. The handler:

1. **Verifies Slack HMAC-SHA256 signature** using `timingSafeEqual` to prevent timing attacks (T-03-20). Signing secret retrieved from AWS Secrets Manager with module-level caching for Lambda warm starts.

2. **Rejects stale requests** with timestamp older than 5 minutes (300 seconds) for replay protection (T-03-21).

3. **Parses URL-encoded body** via `URLSearchParams`, extracting the JSON `payload` field from Slack's `application/x-www-form-urlencoded` format. Handles base64-encoded bodies from API Gateway v2.

4. **Validates approval token** against Postgres via `getApprovalByToken`. Only `pending` tokens can be resolved (T-03-22). Returns 400 for unknown tokens, 200 for already-resolved tokens (idempotent).

5. **Resolves approval** via `resolveApproval` with the Slack username as resolver.

6. **On approval**: Looks up pipeline run from Postgres, constructs a `StageMessage` for the Execute stage using `NEXT_STAGE[PipelineStage.Approve]`, sends it to SQS via `SendMessageCommand`, and updates pipeline status to `running` (T-03-23).

7. **On rejection**: Updates pipeline status to `rejected` in Postgres. No SQS message sent.

8. **Tracks analytics** via PostHog (`approval_approved` / `approval_rejected` events) and flushes before returning.

### Exported API

- `verifySlackSignature(signingSecret, timestamp, body, signature)` -- pure function, exported for testing
- `handleSlackAction(event, pool, sqsClient?)` -- core handler logic with injected dependencies
- `handler(event)` -- Lambda entry point that creates pool and delegates to `handleSlackAction`
- `WebhookHandlerError` -- error class following project pattern

### Unit Tests (`src/cloud/test/slack-webhook.test.ts`)

15 test cases covering:
- Signature verification (invalid signature, stale timestamp)
- Payload parsing (missing payload, invalid JSON, unknown action)
- Token validation (not found, already resolved)
- Approval flow (approve with SQS + pipeline update, reject with pipeline update)
- Analytics tracking (approval_approved, approval_rejected, flush)
- `verifySlackSignature` unit tests (timingSafeEqual, createHmac)
- `WebhookHandlerError` properties

Tests follow the `vi.hoisted()` + `vi.mock()` pattern from `stage-router.test.ts`.

## Deviations from Plan

None -- plan executed exactly as written.

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Slack webhook handler with signature verification, token validation, and SQS resume | fe453be | src/cloud/webhook/slack-handler.ts, src/cloud/test/slack-webhook.test.ts |

## Verification Results

- `npx vitest run src/cloud/test/slack-webhook.test.ts` -- 15/15 tests passing
- `npx vitest run --project cloud-unit` -- 193/193 tests passing (19 files)
- `npx tsc --noEmit` -- exits 0 with no errors
- Signature verification uses `timingSafeEqual` (not `===`)
- Replay protection rejects timestamps older than 5 minutes
- Token validation queries Postgres with parameterized SQL
- SQS message sent only on approval (not rejection)

## Self-Check: PASSED

---
phase: 03-integrations
plan: 04
subsystem: entrypoint, infra, analytics
tags: [git-push, posthog, cdk, api-gateway, slack-webhook, lambda, task-branch]

# Dependency graph
requires:
  - phase: 03-integrations
    plan: 01
    provides: "PostHog analytics utility (track, flush)"
  - phase: 03-integrations
    plan: 02
    provides: "Pipeline Lambda construct pattern, stage queue"
provides:
  - "Git push capability in agent entrypoint (configureGitAuth, createTaskBranch, commitAndPush)"
  - "PostHog agent_run_completed event tracking with cost data"
  - "CDK CahSlackWebhook construct (API Gateway HTTP API + Lambda)"
  - "Slack webhook CfnOutput URL for Slack app configuration"
  - "Placeholder Lambda handler at infra/lambda/slack-webhook/index.js"
affects: [03-05]

# Tech tracking
tech-stack:
  added: [aws-apigatewayv2, aws-apigatewayv2-integrations]
  patterns: [conditional-git-ops, cdk-construct-composition, credential-helper-auth]

key-files:
  created:
    - infra/lib/constructs/slack-webhook.ts
    - infra/lambda/slack-webhook/index.js
  modified:
    - src/cloud/entrypoint/agent-entrypoint.ts
    - src/cloud/test/entrypoint.test.ts
    - infra/lib/cah-stack.ts

key-decisions:
  - "Git operations conditional on CAH_FEATURE_BRANCH + CAH_GITHUB_TOKEN for backward compatibility"
  - "PostHog tracking fires unconditionally for every execute stage run; flush() called before Lambda exit"
  - "Slack signing secret stored in Secrets Manager ARN (env var), not the secret value itself (T-03-17)"
  - "Webhook Lambda IAM scoped to SQS SendMessage (stage queue only) + SecretsManager GetSecretValue (3 secrets)"

patterns-established:
  - "Conditional git auth: credential helper pattern avoids storing tokens in git config files"
  - "Task branch naming: cah/{runId}/{phase}-{plan}-{wave} per D-06"
  - "CDK HTTP API construct: API Gateway v2 + Lambda integration with VPC placement"

requirements-completed: [INTG-01, INTG-02, INTG-04]

# Metrics
duration: 4min
completed: 2026-04-16
---

# Phase 3 Plan 4: Agent Entrypoint Git Push, PostHog Tracking, and CDK Slack Webhook Summary

**Git push capability with task branching in agent entrypoint, PostHog agent_run_completed tracking, and CDK Slack webhook construct with API Gateway HTTP API, least-privilege IAM, and VPC Lambda**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T18:34:00Z
- **Completed:** 2026-04-16T18:38:50Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Added three git helper functions (configureGitAuth, createTaskBranch, commitAndPush) to agent entrypoint for D-06 branch-per-task pattern
- Execute stage creates task branch (cah/{runId}/{phase}-{plan}-{wave}), commits, and pushes when CAH_FEATURE_BRANCH and CAH_GITHUB_TOKEN are set
- PostHog agent_run_completed event tracked with runId, phase, plan, wave, costUsd, success, projectId for every execution
- flush() called before Lambda exit to prevent event loss in serverless environment
- Created CahSlackWebhook CDK construct with HTTP API v2, POST /slack/actions route, VPC Lambda, and least-privilege IAM
- Wired webhook into cah-stack with Secrets Manager references for Slack signing secret and bot token
- Added SlackWebhookUrl CfnOutput for Slack app interactivity configuration
- Created placeholder Lambda handler for CDK synthesis compatibility
- Added 8 new unit tests covering git operations and PostHog tracking (21 total tests passing)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add git push capability and PostHog agent run tracking to entrypoint** - `6d0f892` (feat)
2. **Task 2: Create CDK Slack webhook construct and wire into cah-stack** - `93371b3` (feat)

## Files Created/Modified
- `src/cloud/entrypoint/agent-entrypoint.ts` - Added git helper functions (configureGitAuth, createTaskBranch, commitAndPush), PostHog tracking (agent_run_completed), conditional git ops in execute stage
- `src/cloud/test/entrypoint.test.ts` - Added analytics mock, 8 new tests for git operations and PostHog tracking
- `infra/lib/constructs/slack-webhook.ts` - New CDK construct with HTTP API v2, Lambda, IAM (SQS SendMessage + SecretsManager), VPC placement, /slack/actions route
- `infra/lambda/slack-webhook/index.js` - Placeholder handler for CDK Code.fromAsset() synthesis
- `infra/lib/cah-stack.ts` - Added CahSlackWebhook import, Secrets Manager references, construct instantiation, SlackWebhookUrl CfnOutput

## Decisions Made
- Git operations are conditional on CAH_FEATURE_BRANCH and CAH_GITHUB_TOKEN being set -- preserves backward compatibility with Phase 2 S3-only upload behavior
- PostHog tracking fires unconditionally for every execute stage run, regardless of git configuration
- Slack signing secret stored as Secrets Manager ARN in Lambda env var (not the secret value) per T-03-17
- Webhook Lambda IAM uses least-privilege: SQS SendMessage scoped to stage queue ARN, SecretsManager scoped to 3 specific secret ARNs

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed mock return type for execSync in tests**
- **Found during:** Task 1
- **Issue:** Default mock returned `Buffer.from('')` but new git helper functions call `.trim()` expecting string return from `encoding: 'utf-8'`
- **Fix:** Changed default mock from `Buffer.from('')` to empty string `''` which works for both string and buffer contexts
- **Files modified:** src/cloud/test/entrypoint.test.ts
- **Commit:** 6d0f892

## Known Stubs

| File | Line | Reason |
|------|------|--------|
| infra/lambda/slack-webhook/index.js | 10 | Placeholder Lambda handler required by CDK Code.fromAsset() during synthesis. Actual handler created in Plan 05 at src/cloud/webhook/slack-handler.ts |

This stub does not prevent the plan's goal -- CDK synthesis succeeds and the construct is fully wired. The stub will be replaced when Plan 05 implements the actual Slack webhook handler.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required at this stage. Slack signing secret and bot token must be created in Secrets Manager before deployment (handled by ops/deployment docs).

## Next Phase Readiness
- Agent entrypoint ready for sandbox execution with git push to task branches
- CDK webhook construct ready for Plan 05 to implement the actual Slack webhook handler
- PostHog agent_run_completed events will flow once POSTHOG_API_KEY is set in sandbox environment
- SlackWebhookUrl output available for configuring Slack app interactivity settings after deployment

## Self-Check: PASSED

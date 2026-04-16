# Phase 3: Integrations - Research

**Researched:** 2026-04-16
**Domain:** External system integrations (Slack, GitHub, Linear, PostHog) for cloud pipeline
**Confidence:** HIGH

## Summary

Phase 3 connects the existing SQS-based pipeline (from Phases 1-2) to four external systems: Slack for human-in-the-loop plan approval, GitHub for PR delivery, Linear for ticket tracking, and PostHog for event instrumentation. The pipeline already has placeholder stage handlers (`approve.ts`, `pr.ts`) with correct function signatures, a working stage router with SQS message dispatch, Postgres state management with idempotency, and CDK infrastructure. This phase replaces placeholders with real integrations and extends existing stages (intake) with new capabilities.

The primary architectural challenge is the Slack approval flow, which introduces an asynchronous pause in the pipeline. The existing stage router only handles `completed`, `failed`, and `skipped` statuses -- it must now handle `paused` as a terminal state for the approve stage. A new Slack webhook Lambda (separate from the stage router Lambda) behind API Gateway receives button callbacks and re-enqueues the next stage message to SQS, resuming the pipeline.

**Primary recommendation:** Implement each integration as a thin utility module (`src/cloud/integrations/{slack,github,linear,posthog}.ts`) that wraps the respective SDK client. Stage handlers import these utilities. New CDK constructs add API Gateway + webhook Lambda for Slack. PostHog is the simplest integration and should be implemented first as a warm-up.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Postgres token re-enqueue pattern. The approve stage writes a pending-approval row with a UUID token to a new `approvals` table in Postgres, then returns `status: 'paused'` without advancing the SQS pipeline.
- **D-02:** A new Slack webhook Lambda (behind API Gateway) receives the Slack button callback, validates the token against Postgres, marks the approval as accepted/rejected, and sends the next-stage SQS message to resume the pipeline on approval.
- **D-03:** The stage-router must handle `status: 'paused'` as a terminal state for the approve stage (no NEXT_STAGE advancement). The Slack webhook Lambda is responsible for re-enqueuing.
- **D-04:** Slack message uses Block Kit with approve/reject buttons. The message includes the plan summary and pipeline context so the user can make an informed decision without leaving Slack.
- **D-05:** Feature branch created at intake stage. Intake Lambda creates a feature branch (e.g., `cah/{run_id_short}/{feature-slug}`) and records it in the `pipeline_runs` table. All downstream stages read the feature branch name from StageMessage context.
- **D-06:** Branch-per-task pattern. Each agent in a Daytona sandbox clones the repo, checks out the feature branch, creates a task-specific branch (e.g., `cah/{run_id}/{phase}-{plan}-{wave}`), commits normally, and pushes to remote.
- **D-07:** Integration executor merges task branches back into the feature branch in wave-DAG order after all agents in a wave complete. This mirrors the local GSD harness worktree merge pattern.
- **D-08:** PR stage opens a pull request from the feature branch to main with a structured description summarizing all phases, plans, and agent task outcomes.
- **D-09:** Pipeline-created tickets. Intake stage creates a parent Linear ticket for the pipeline run. No upstream webhook dependency.
- **D-10:** Sub-ticket per phase. Each phase creates a sub-ticket linked to the parent via Linear's `parentId` on `issueCreate`. Stage transitions update the active phase's sub-ticket status.
- **D-11:** PR URL linked to the parent ticket on completion via Linear's `attachmentCreate` API. Parent ticket marked done when the PR is opened.
- **D-12:** Thin PostHog utility file (`src/cloud/analytics.ts`, ~20-30 lines) wrapping `posthog-node` client initialization, a `track()` helper for consistent event structure, and a `flush()` function for Lambda shutdown.
- **D-13:** Each stage Lambda imports the utility and calls `track()` directly. No heavyweight abstraction.
- **D-14:** Event name conventions documented (not enforced by typed functions). Consistent naming like `pipeline_started`, `phase_transition`, `agent_run_completed`, `approval_requested`, `pr_created`.

### Claude's Discretion
- Slack Block Kit message layout and content structure
- Approval token expiry policy (if any)
- API Gateway configuration (REST vs HTTP API, auth)
- Feature branch naming exact format
- Integration executor implementation (Lambda vs. dedicated stage)
- Linear ticket field mapping (team, project, labels, priority)
- Linear status names to map pipeline stages to
- PostHog event property schemas beyond the core fields
- PostHog distinct_id strategy (runId vs. projectId)
- Error handling and retry behavior for each integration

### Deferred Ideas (OUT OF SCOPE)
- Linear webhook triggering pipeline runs (ticket-triggered flow)
- Hybrid Linear upsert (accept optional ticketId)
- Step Functions for approval gate
- Lambda Durable Functions
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INTG-01 | Slack approval workflow with Block Kit approve/reject buttons for plan approval | Slack Web API `chat.postMessage` with Block Kit actions block; API Gateway + Lambda webhook for interactive payloads; Postgres approvals table for token persistence; stage router `paused` status handling |
| INTG-02 | Git integration and PR delivery (branch creation, atomic commits per task, PR with structured description) | Octokit REST `pulls.create` for PR creation; git CLI for branch creation/merge in Daytona sandboxes; intake stage extension for feature branch; integration executor for wave merge |
| INTG-03 | Linear integration with pipeline status updates on ticket and PR link-back on completion | Linear SDK `createIssue` with `parentId` for sub-tickets; `issueUpdate` with `stateId` for status transitions; `attachmentCreate` for PR link-back |
| INTG-04 | PostHog event tracking for agent runs, token usage, cost, pipeline status, and phase transitions | posthog-node `capture()` with consistent event naming; `shutdown()` for Lambda flush; thin utility wrapper per D-12 |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Slack approval message send | API / Backend (approve stage Lambda) | -- | Server-side Slack Web API call from Lambda |
| Slack button callback handling | API / Backend (webhook Lambda) | -- | New Lambda behind API Gateway receives POST from Slack |
| Approval token persistence | Database / Storage (Postgres) | -- | New `approvals` table for token validation |
| Pipeline pause/resume | API / Backend (stage router + webhook Lambda) | Database / Storage | Router handles `paused`; webhook re-enqueues via SQS |
| Feature branch creation | API / Backend (intake Lambda) | -- | git CLI from within Lambda/Daytona |
| Task branch create/push | Agent Runtime (Daytona sandbox) | -- | Each agent creates and pushes its task branch |
| Wave merge (integration executor) | API / Backend (executor stage or Lambda) | -- | Orchestrator merges task branches into feature branch |
| PR creation | API / Backend (PR stage Lambda) | -- | Octokit REST API call from Lambda |
| Linear ticket creation | API / Backend (intake Lambda) | -- | Linear SDK call during intake |
| Linear status updates | API / Backend (stage router) | -- | Linear SDK call at each stage transition |
| Linear PR link-back | API / Backend (PR stage Lambda) | -- | `attachmentCreate` after PR created |
| PostHog event tracking | API / Backend (all stage Lambdas) | -- | `posthog-node` capture() in each stage handler |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@slack/web-api` | 7.15.1 | Send Block Kit messages to Slack channels | Official Slack SDK for Node.js; typed API methods; handles rate limiting and retries [VERIFIED: npm registry] |
| `@octokit/rest` | 22.0.1 | Create pull requests and manage branches on GitHub | Official GitHub REST API client; typed methods; handles pagination [VERIFIED: npm registry] |
| `@linear/sdk` | 81.0.0 | Create/update Linear tickets and attachments | Official Linear TypeScript SDK; typed GraphQL client; handles pagination [VERIFIED: npm registry] |
| `posthog-node` | 5.29.2 | Server-side event tracking and analytics | Official PostHog Node.js SDK; batch-mode flushing suitable for Lambda [VERIFIED: npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `aws-cdk-lib` | 2.250.0 | CDK constructs for API Gateway, Lambda | Already in project; add API Gateway + webhook Lambda constructs [VERIFIED: npm registry] |
| `@types/aws-lambda` | 8.10.161 | TypeScript types for Lambda handler events | Type the webhook Lambda handler (APIGatewayProxyEvent) [VERIFIED: npm registry] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@slack/web-api` | `@slack/bolt` (v4.7.0) | Bolt is a framework with Express-like server; overkill for Lambda-native webhook handler. `@slack/web-api` is lighter for message sending only. |
| `@octokit/rest` | `gh` CLI | CLI works but requires installation in Lambda; Octokit is a proper SDK with types |
| Direct GraphQL | `@linear/sdk` | SDK wraps GraphQL with typed methods; less boilerplate than raw fetch |

**Installation:**
```bash
npm install @slack/web-api @octokit/rest @linear/sdk posthog-node
```

**Version verification:** All versions confirmed against npm registry on 2026-04-16.

## Architecture Patterns

### System Architecture Diagram

```
                                    Slack Channel
                                   /            \
                          [Block Kit msg]    [Button click]
                                /                  \
                               v                    v
[SQS Job Queue] --> [Stage Router Lambda]    [API Gateway]
       |                |    |    |               |
       |           +----|----|----|----+     [Webhook Lambda]
       |           |    |    |    |   |           |
       |           v    v    v    v   v           |
       |      Intake Research Plan Approve  Execute  Verify  PR
       |        |                   |                         |
       |        |  [writes pending  |                         |
       |        |   approval row]   |                [Octokit PR create]
       |        |        |          |                         |
       |     [creates    |     [returns 'paused']             |
       |    feature      |          |                    [Linear attach]
       |    branch +     |     [no SQS advance]               |
       |    Linear       v                                    |
       |    ticket]  [Postgres                                |
       |             approvals table]                         |
       |                  ^                                   |
       |                  |                                   |
       |            [Webhook validates                        |
       |             token, sends SQS]                        |
       |                  |                                   |
       |           [Pipeline resumes]                         |
       |                                                      |
       +---> [PostHog track() called at every stage] <--------+
                              |
                         [PostHog Cloud]

  [Daytona Sandboxes]
       |
  [Agent creates task branch, pushes to remote]
       |
  [Integration executor merges task branches -> feature branch]
```

### Recommended Project Structure

```
src/cloud/
  integrations/
    slack.ts           # Slack Web API wrapper (postMessage, Block Kit builder)
    github.ts          # Octokit wrapper (PR creation, branch management)
    linear.ts          # Linear SDK wrapper (ticket CRUD, status mapping)
  analytics.ts         # PostHog thin utility (per D-12)
  pipeline/
    stages/
      approve.ts       # Replace auto-approve with Slack + Postgres approval
      intake.ts        # Extend with feature branch + Linear ticket creation
      pr.ts            # Replace placeholder with git assembly + PR creation
    stage-router.ts    # Add 'paused' status handling (D-03)
    types.ts           # Add 'paused' to StageResult.status union
    merge-executor.ts  # Integration executor for wave merge (D-07)
  webhook/
    slack-handler.ts   # Slack webhook Lambda handler (API Gateway -> SQS)
infra/lib/
  constructs/
    slack-webhook.ts   # CDK construct: API Gateway + webhook Lambda
  cah-stack.ts         # Extended with Slack webhook construct
scripts/
  migrate-003-approvals.sql  # New approvals table + pipeline_runs extensions
```

### Pattern 1: Slack Approval Pause/Resume

**What:** The approve stage sends a Slack message with Block Kit buttons, writes a pending approval row to Postgres with a UUID token, and returns `status: 'paused'`. The stage router treats `paused` as terminal (no SQS advance). When a user clicks Approve in Slack, the webhook Lambda validates the token, marks the row as approved, and sends an SQS message to resume the pipeline.

**When to use:** Any pipeline stage that requires human approval before proceeding.

**Example:**
```typescript
// Source: Slack Web API docs + project patterns
// src/cloud/integrations/slack.ts
import { WebClient } from '@slack/web-api';

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function sendApprovalMessage(
  channel: string,
  runId: string,
  approvalToken: string,
  planSummary: string,
): Promise<string> {
  const result = await slackClient.chat.postMessage({
    channel,
    text: `Pipeline approval requested for run ${runId}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Pipeline Plan Approval' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: planSummary },
      },
      {
        type: 'actions',
        block_id: `approval_${approvalToken}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'pipeline_approve',
            value: approvalToken,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reject' },
            style: 'danger',
            action_id: 'pipeline_reject',
            value: approvalToken,
          },
        ],
      },
    ],
  });
  return result.ts ?? '';
}
```

### Pattern 2: Webhook Lambda with Slack Signature Verification

**What:** A Lambda behind API Gateway receives Slack interactive payloads, verifies the request signature using HMAC-SHA256, parses the `payload` form parameter, and processes the action.

**When to use:** Any Slack interactive callback endpoint.

**Example:**
```typescript
// Source: Slack API docs - verifying requests from Slack
// [CITED: docs.slack.dev/reference/interaction-payloads/block_actions-payload]
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  // Reject requests older than 5 minutes (replay protection)
  const fiveMinutes = 5 * 60;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) {
    return false;
  }
  const sigBaseString = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${createHmac('sha256', signingSecret)
    .update(sigBaseString)
    .digest('hex')}`;
  return timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature),
  );
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const body = event.body ?? '';
  const timestamp = event.headers['x-slack-request-timestamp'] ?? '';
  const signature = event.headers['x-slack-signature'] ?? '';

  if (!verifySlackSignature(SIGNING_SECRET, timestamp, body, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // Slack sends payload as application/x-www-form-urlencoded
  const params = new URLSearchParams(body);
  const payload = JSON.parse(params.get('payload') ?? '{}');

  // payload.actions[0].action_id is 'pipeline_approve' or 'pipeline_reject'
  // payload.actions[0].value is the approval token
  // ... validate token, update Postgres, send SQS message
  return { statusCode: 200, body: '' };
}
```

### Pattern 3: Linear Ticket Hierarchy

**What:** Intake creates a parent ticket. Each phase creates a sub-ticket via `parentId`. Status updates use `issueUpdate` with `stateId`.

**Example:**
```typescript
// Source: Linear SDK docs
// [CITED: linear.app/developers/sdk]
import { LinearClient } from '@linear/sdk';

const linearClient = new LinearClient({ apiKey: LINEAR_API_KEY });

// Create parent ticket at intake
const parentIssue = await linearClient.createIssue({
  teamId: TEAM_ID,
  title: `[CAH] ${featureDescription}`,
  description: `Pipeline run: ${runId}`,
});

// Create sub-ticket per phase
const subIssue = await linearClient.createIssue({
  teamId: TEAM_ID,
  title: `Phase ${phaseNumber}: ${phaseName}`,
  parentId: parentIssue.issue?.id,
});

// Update status
await linearClient.updateIssue(issueId, { stateId: IN_PROGRESS_STATE_ID });

// Attach PR URL on completion
// [CITED: linear.app/developers/attachments]
await linearClient.createAttachment({
  issueId: parentIssueId,
  title: 'Pull Request',
  url: prUrl,
});
```

### Pattern 4: PostHog Thin Utility

**What:** A minimal utility wrapping posthog-node client initialization, a `track()` helper, and `flush()` for Lambda shutdown.

**Example:**
```typescript
// Source: PostHog Node.js SDK docs
// [CITED: context7.com/posthog/posthog-js/llms.txt]
// src/cloud/analytics.ts (per D-12)
import { PostHog } from 'posthog-node';

let client: PostHog | undefined;

function getClient(): PostHog {
  if (!client) {
    client = new PostHog(process.env.POSTHOG_API_KEY ?? '', {
      host: 'https://us.i.posthog.com',
      flushAt: 1,       // Flush immediately in Lambda
      flushInterval: 0,  // No interval batching in Lambda
    });
  }
  return client;
}

export function track(
  event: string,
  properties: Record<string, unknown>,
  distinctId?: string,
): void {
  getClient().capture({
    distinctId: distinctId ?? (properties.runId as string) ?? 'system',
    event,
    properties,
  });
}

export async function flush(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = undefined;
  }
}
```

### Anti-Patterns to Avoid
- **Storing Slack tokens in Lambda env vars:** Use Secrets Manager for bot tokens and signing secrets. Lambda env vars are visible in console. [ASSUMED]
- **Synchronous approval polling:** Never poll Postgres waiting for approval. The webhook Lambda pushes to SQS; the pipeline is event-driven.
- **Large PostHog batch sizes in Lambda:** Lambda freezes between invocations. Use `flushAt: 1` and `flushInterval: 0` to ensure events are sent before the Lambda returns. [CITED: posthog-node docs recommend flush before shutdown]
- **Using `@slack/bolt` for webhook Lambda:** Bolt expects a long-running Express server. For a Lambda handler receiving API Gateway events, use `@slack/web-api` for sending messages and handle interactive payloads directly from the raw event. [ASSUMED]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack message formatting | Custom message JSON builders | `@slack/web-api` `chat.postMessage` with Block Kit JSON | Block Kit has strict schema; SDK handles serialization, retries, rate limits |
| Slack request verification | Custom HMAC verification from scratch | Node.js `crypto.createHmac` + `timingSafeEqual` | The verification algorithm is simple but must use timing-safe comparison to prevent timing attacks. No need for `@slack/bolt` just for verification. |
| GitHub PR creation | Raw `fetch` to GitHub API | `@octokit/rest` `pulls.create` | Handles auth, pagination, rate limits, retries, types |
| Linear GraphQL queries | Raw `fetch` with GraphQL strings | `@linear/sdk` typed client methods | SDK generates typed methods from schema; handles pagination, errors |
| Event tracking | Custom HTTP client to PostHog API | `posthog-node` SDK | Handles batching, flushing, retries, shutdown semantics |
| UUID token generation | Custom random string | `crypto.randomUUID()` | Built-in, cryptographically secure, already used in project |

**Key insight:** Each integration has an official SDK that handles the hard parts (retries, rate limits, types, serialization). The custom code in this phase should be thin wrappers that inject project-specific conventions (idempotency keys, structured logging, error handling) around SDK calls.

## Common Pitfalls

### Pitfall 1: Slack 3-Second Response Timeout
**What goes wrong:** Slack requires an HTTP 200 response within 3 seconds of sending an interactive payload. If the webhook Lambda does database lookups and SQS sends before responding, it may exceed this timeout.
**Why it happens:** Slack interactive webhooks are synchronous -- they expect a fast acknowledgment.
**How to avoid:** Return `200` immediately with an empty body (or a simple message), then perform async work. In a Lambda context, the handler should do Postgres validation and SQS send, which should complete well within 3 seconds given Lambda-to-RDS and Lambda-to-SQS latency. If it becomes an issue, split into two Lambdas (ack + process).
**Warning signs:** Slack shows "Oops, something went wrong" when the user clicks a button.
[CITED: docs.slack.dev/messaging/creating-interactive-messages]

### Pitfall 2: API Gateway Payload Format for Slack
**What goes wrong:** Slack sends interactive payloads as `application/x-www-form-urlencoded` with a `payload` parameter, not as JSON. If the Lambda handler tries to `JSON.parse(event.body)` directly, it fails.
**Why it happens:** Legacy Slack format. Developers expect JSON from API Gateway.
**How to avoid:** Parse `event.body` as URL-encoded form data first, extract the `payload` parameter, then JSON.parse that. If using API Gateway v2 (HTTP API), ensure `isBase64Encoded` is handled.
**Warning signs:** Lambda handler throws "Unexpected token p" JSON parse error.
[CITED: docs.slack.dev/reference/interaction-payloads/block_actions-payload]

### Pitfall 3: Slack Signing Secret vs Bot Token
**What goes wrong:** Developers confuse the Slack signing secret (for request verification) with the bot token (for API calls). Using the wrong one in the wrong place silently fails or rejects all requests.
**Why it happens:** Slack apps have multiple credentials: App ID, Signing Secret, Bot Token, Client Secret.
**How to avoid:** Store them as separate Secrets Manager entries: `cah-dev-slack-signing-secret` and `cah-dev-slack-bot-token`. The webhook Lambda needs the signing secret; the approve stage Lambda needs the bot token.
**Warning signs:** All webhook requests return 401; or messages fail to send.
[ASSUMED]

### Pitfall 4: Git Push Permissions in Daytona Sandbox
**What goes wrong:** Agents in Daytona sandboxes need to push branches to the remote repository. Without proper GitHub credentials in the sandbox, `git push` fails.
**Why it happens:** The current entrypoint script (`agent-entrypoint.ts`) doesn't push to remote -- it only uploads modified files to S3. Phase 3 changes this to push task branches.
**How to avoid:** Inject a GitHub token via environment variable (CAH_GITHUB_TOKEN) into the Daytona sandbox. Configure git to use the token for HTTPS auth: `git config credential.helper '!f() { echo "password=${CAH_GITHUB_TOKEN}"; }; f'` or use `GIT_ASKPASS`.
**Warning signs:** Agent tasks succeed but no branches appear on GitHub remote.
[ASSUMED]

### Pitfall 5: PostHog Event Loss in Lambda
**What goes wrong:** PostHog batches events in memory. If the Lambda returns before flushing, events are lost when the execution environment freezes.
**Why it happens:** Lambda freezes the execution environment between invocations. Unflushed buffers are discarded.
**How to avoid:** Call `await client.shutdown()` (which flushes) before the Lambda handler returns. The thin utility's `flush()` function wraps this.
**Warning signs:** Events appear sporadically in PostHog dashboard, with gaps.
[CITED: posthog-node docs - call shutdown() to ensure events are flushed]

### Pitfall 6: Linear API Key vs OAuth Token
**What goes wrong:** Using a personal API key for a service integration means the key is tied to a specific person's account and permissions.
**Why it happens:** Personal API keys are easiest to generate but inappropriate for service-to-service communication.
**How to avoid:** Create a Linear "service account" or use an OAuth application integration. For v1 with a solo team, a personal API key is acceptable but should be stored in Secrets Manager and documented for future migration.
**Warning signs:** Tickets appear as created by a specific person rather than the service.
[ASSUMED]

### Pitfall 7: StageResult Type Union Not Updated
**What goes wrong:** The `StageResult.status` type is `'completed' | 'failed' | 'skipped'`. Adding `'paused'` to the approve stage without updating the type union causes TypeScript to flag it.
**Why it happens:** The type is used by the stage router and checkpoint module.
**How to avoid:** Update the `StageResult.status` type union in `src/cloud/pipeline/types.ts` to include `'paused'` BEFORE modifying the approve handler or stage router.
**Warning signs:** TypeScript compilation errors in approve.ts and stage-router.ts.
[VERIFIED: src/cloud/pipeline/types.ts line 99 shows current union]

## Code Examples

### Database Migration: Approvals Table

```sql
-- scripts/migrate-003-approvals.sql
-- Approval tokens for Slack-based pipeline approval gate (D-01)

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  token UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  slack_channel TEXT,
  slack_message_ts TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_token ON approvals(token);
CREATE INDEX IF NOT EXISTS idx_approvals_pipeline_run ON approvals(pipeline_run_id);

-- Add feature branch and Linear ticket tracking to pipeline_runs
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS feature_branch TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS linear_parent_ticket_id TEXT;
```

### StageResult Type Extension

```typescript
// src/cloud/pipeline/types.ts -- update status union
export interface StageResult {
  stage: PipelineStage;
  status: 'completed' | 'failed' | 'skipped' | 'paused';
  tasks: AgentTaskOutcome[];
  error?: string;
}
```

### Stage Router: Handle 'paused' Status

```typescript
// src/cloud/pipeline/stage-router.ts -- add to post-handler logic
// After: const result = await handler(msg, pool, client, bucket);

if (result.status === 'paused') {
  // D-03: Approve stage returned 'paused' -- do NOT advance pipeline
  // The Slack webhook Lambda is responsible for re-enqueuing
  await pool.query(
    `UPDATE pipeline_runs SET current_stage = $1, status = 'paused' WHERE id = $2`,
    [msg.stage, msg.runId],
  );
  return result;
}
```

### CDK: API Gateway + Webhook Lambda

```typescript
// infra/lib/constructs/slack-webhook.ts
// [CITED: aws-cdk-lib/aws-apigatewayv2 + aws-lambda docs]
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class CahSlackWebhook extends Construct {
  public readonly api: apigw.HttpApi;
  public readonly webhookFn: lambda.Function;

  constructor(scope: Construct, id: string, props: {
    prefix: string;
    stageQueueUrl: string;
    stageQueueArn: string;
    dbSecretArn: string;
    slackSigningSecret: secretsmanager.ISecret;
    slackBotToken: secretsmanager.ISecret;
    // VPC + security group for RDS connectivity
    vpc: cdk.aws_ec2.IVpc;
    dbSecurityGroup: cdk.aws_ec2.ISecurityGroup;
  }) {
    super(scope, id);

    // HTTP API (lighter weight than REST API, sufficient for webhooks)
    this.api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${props.prefix}-slack-webhook`,
    });

    this.webhookFn = new lambda.Function(this, 'WebhookFn', {
      functionName: `${props.prefix}-slack-webhook`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/slack-webhook'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      vpc: props.vpc,
      environment: {
        STAGE_QUEUE_URL: props.stageQueueUrl,
        SLACK_SIGNING_SECRET_ARN: props.slackSigningSecret.secretArn,
        DB_SECRET_ARN: props.dbSecretArn,
      },
    });

    // Route: POST /slack/actions
    this.api.addRoutes({
      path: '/slack/actions',
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'SlackWebhook',
        this.webhookFn,
      ),
    });
  }
}
```

### Octokit PR Creation

```typescript
// Source: Octokit REST API docs
// [CITED: octokit.github.io/rest.js]
import { Octokit } from '@octokit/rest';

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number }> {
  const octokit = new Octokit({ auth: token });
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
  });
  return { url: pr.html_url, number: pr.number };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Slack legacy attachments with callbacks | Block Kit with `action_id` in actions blocks | 2020+ | Use Block Kit exclusively; legacy format deprecated |
| Slack request verification with verification token | Signing secret with HMAC-SHA256 | 2019+ | Signing secret is mandatory; verification tokens deprecated |
| REST API v1 for Slack | REST API v2 with Block Kit | 2020+ | Modern apps must use Block Kit for interactive messages |
| Octokit v18-v20 | Octokit v22 | 2024 | v22 requires `moduleResolution: "node16"` in tsconfig |
| PostHog v3 (posthog-node) | PostHog v5 (posthog-node) | 2024-2025 | v5 has improved shutdown/flush semantics |
| Linear REST API | Linear GraphQL API + TypeScript SDK | 2021+ | SDK auto-generates typed methods from schema |

**Deprecated/outdated:**
- Slack verification tokens: Replaced by signing secrets. Do not use `token` field in payloads for verification.
- Slack legacy message attachments: Use Block Kit instead. Legacy format still works but is not recommended for new apps.
- `@octokit/rest` v20 and below: v22 is current; breaking changes in auth handling.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Slack bot token and signing secret should be stored in Secrets Manager, not Lambda env vars | Anti-Patterns | Low -- env vars work functionally but are visible in console; Secrets Manager is best practice |
| A2 | `@slack/bolt` is overkill for Lambda webhook handler | Alternatives Considered | Low -- Bolt can work in Lambda mode but adds unnecessary dependency and complexity |
| A3 | GitHub token needs to be injected into Daytona sandbox for git push | Pitfalls | HIGH -- if agents cannot push to remote, the entire branch-per-task pattern fails |
| A4 | Personal Linear API key is acceptable for v1 but should use service account | Pitfalls | Low -- functional either way; affects only ticket attribution |
| A5 | API Gateway HTTP API (v2) is sufficient for Slack webhook; REST API (v1) is unnecessary | Architecture | Low -- HTTP API is simpler and cheaper; REST API adds features not needed here |
| A6 | Slack interactive payloads are sent as `application/x-www-form-urlencoded` | Pitfalls | Low -- well-documented in Slack docs, confirmed via Context7 |

## Open Questions

1. **Slack Channel Configuration**
   - What we know: The approve stage sends a message to a Slack channel. The channel ID must be configured somewhere.
   - What's unclear: Should the channel be per-project, per-pipeline-run, or a single global channel? Is it an env var, Secrets Manager entry, or Postgres config?
   - Recommendation: Use an environment variable `SLACK_APPROVAL_CHANNEL` on the stage router Lambda. Simple and configurable per deployment. Can be moved to per-project config in v2.

2. **GitHub Token Provisioning for Daytona Sandboxes**
   - What we know: Agents need to `git push` task branches to the remote. The current `sandbox-task.ts` injects `ANTHROPIC_API_KEY` from Secrets Manager.
   - What's unclear: Where does the GitHub token come from? Is it per-repository, per-organization, or a GitHub App installation token?
   - Recommendation: Store a GitHub PAT (fine-grained, scoped to the target repo) in Secrets Manager. Inject as `CAH_GITHUB_TOKEN` env var in the sandbox, similar to `ANTHROPIC_API_KEY`. For v1 this is the simplest path.

3. **Linear Team ID and State IDs**
   - What we know: `issueCreate` requires `teamId`. `issueUpdate` with status change requires `stateId`.
   - What's unclear: These IDs are organization-specific. They need to be configured per deployment.
   - Recommendation: Store Linear team ID and state ID mapping (e.g., `{ "todo": "state-uuid-1", "in_progress": "state-uuid-2", "done": "state-uuid-3" }`) in Secrets Manager alongside the API key, or as environment variables on the Lambda.

4. **Integration Executor: Lambda vs. Dedicated Stage**
   - What we know: D-07 specifies that after all agents in a wave complete, task branches must be merged back into the feature branch in wave-DAG order.
   - What's unclear: Does this happen inside the execute stage handler (after each wave), or as a separate stage between Execute and Verify?
   - Recommendation: Implement as logic within the execute stage handler. After each wave of agents completes, the executor merges their task branches into the feature branch before starting the next wave. This keeps the pipeline stage count unchanged and mirrors how the local harness handles wave completion.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All Lambdas | Yes | 22.18.0 | -- |
| npm | Package install | Yes | 10.9.3 | -- |
| git | Branch operations | Yes | 2.39.5 | -- |
| AWS CDK | Infrastructure | Yes | 2.250.0 | -- |
| Slack App (bot token + signing secret) | INTG-01 | External config needed | -- | Cannot proceed without |
| GitHub PAT or App token | INTG-02 | External config needed | -- | Cannot proceed without |
| Linear API key | INTG-03 | External config needed | -- | Cannot proceed without |
| PostHog project API key | INTG-04 | External config needed | -- | Cannot proceed without |

**Missing dependencies with no fallback:**
- Slack App credentials, GitHub token, Linear API key, PostHog API key all require external setup. The CDK stack should reference Secrets Manager entries; actual secret values are provisioned manually before first deployment.

**Missing dependencies with fallback:**
- None. All external dependencies are mandatory for their respective requirements.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.2 |
| Config file | `vitest.config.ts` (cloud-unit project) |
| Quick run command | `npx vitest run --project cloud-unit` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTG-01a | Approve stage sends Slack message and writes approval token | unit | `npx vitest run src/cloud/test/approve.test.ts -t "sends slack"` | No -- Wave 0 |
| INTG-01b | Approve stage returns 'paused' status | unit | `npx vitest run src/cloud/test/approve.test.ts -t "paused"` | No -- Wave 0 |
| INTG-01c | Stage router handles 'paused' without SQS advance | unit | `npx vitest run src/cloud/test/stage-router.test.ts -t "paused"` | Partial (file exists, test case needed) |
| INTG-01d | Webhook Lambda validates token, marks approval, sends SQS | unit | `npx vitest run src/cloud/test/slack-webhook.test.ts` | No -- Wave 0 |
| INTG-01e | Webhook Lambda rejects invalid Slack signature | unit | `npx vitest run src/cloud/test/slack-webhook.test.ts -t "signature"` | No -- Wave 0 |
| INTG-02a | Intake creates feature branch | unit | `npx vitest run src/cloud/test/intake.test.ts -t "feature branch"` | No -- Wave 0 |
| INTG-02b | PR stage creates pull request via Octokit | unit | `npx vitest run src/cloud/test/pr.test.ts` | No -- Wave 0 |
| INTG-02c | Merge executor merges task branches in order | unit | `npx vitest run src/cloud/test/merge-executor.test.ts` | No -- Wave 0 |
| INTG-03a | Intake creates parent Linear ticket | unit | `npx vitest run src/cloud/test/intake.test.ts -t "linear"` | No -- Wave 0 |
| INTG-03b | Stage transitions update Linear ticket status | unit | `npx vitest run src/cloud/test/linear.test.ts -t "status"` | No -- Wave 0 |
| INTG-03c | PR stage attaches PR URL to Linear ticket | unit | `npx vitest run src/cloud/test/pr.test.ts -t "linear"` | No -- Wave 0 |
| INTG-04a | PostHog utility initializes client and captures events | unit | `npx vitest run src/cloud/test/analytics.test.ts` | No -- Wave 0 |
| INTG-04b | PostHog flush called before Lambda return | unit | `npx vitest run src/cloud/test/analytics.test.ts -t "flush"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --project cloud-unit`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/cloud/test/approve.test.ts` -- covers INTG-01a, INTG-01b (replace or extend from auto-approve tests)
- [ ] `src/cloud/test/slack-webhook.test.ts` -- covers INTG-01d, INTG-01e
- [ ] `src/cloud/test/pr.test.ts` -- covers INTG-02b, INTG-03c
- [ ] `src/cloud/test/merge-executor.test.ts` -- covers INTG-02c
- [ ] `src/cloud/test/linear.test.ts` -- covers INTG-03b
- [ ] `src/cloud/test/analytics.test.ts` -- covers INTG-04a, INTG-04b
- [ ] Add `paused` test cases to existing `src/cloud/test/stage-router.test.ts` -- covers INTG-01c
- [ ] Framework install: `npm install @slack/web-api @octokit/rest @linear/sdk posthog-node` -- new dependencies

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Slack signing secret verification (HMAC-SHA256); GitHub PAT/token auth; Linear API key auth |
| V3 Session Management | No | No user sessions -- pipeline is event-driven |
| V4 Access Control | Yes | Approval token validation; Secrets Manager for all API keys; IAM least-privilege |
| V5 Input Validation | Yes | Slack payload parsing with type guards; approval token UUID format validation |
| V6 Cryptography | Yes | HMAC-SHA256 for Slack signature verification; `crypto.timingSafeEqual` for timing-safe comparison |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Slack webhook forgery | Spoofing | HMAC-SHA256 signature verification with signing secret |
| Replay attack on Slack webhook | Tampering | Timestamp validation (reject requests > 5 min old) |
| Approval token guessing | Spoofing | UUID v4 tokens (122 bits of entropy); single-use; expired after resolution |
| API key exposure in Lambda env vars | Information Disclosure | Store in Secrets Manager; Lambda reads at cold start; never log |
| Unauthorized SQS message injection | Elevation of Privilege | SQS queue policy restricts SendMessage to webhook Lambda role only |
| Git credential leakage in logs | Information Disclosure | Never log CAH_GITHUB_TOKEN; Daytona sandbox is ephemeral |

## Sources

### Primary (HIGH confidence)
- `@slack/web-api` v7.15.1 -- verified via npm registry
- `@octokit/rest` v22.0.1 -- verified via npm registry
- `@linear/sdk` v81.0.0 -- verified via npm registry
- `posthog-node` v5.29.2 -- verified via npm registry
- `aws-cdk-lib` v2.250.0 -- verified via npm registry
- Context7 `/websites/api_slack` -- Slack interactive messages, Block Kit buttons
- Context7 `/websites/slack_dev_reference_block-kit` -- Block Kit confirmation dialogs, button elements
- Context7 `/websites/linear_app_developers` -- Linear SDK initialization, issue CRUD, attachments
- Context7 `/posthog/posthog-js` -- PostHog Node.js SDK capture, shutdown patterns
- Context7 `/octokit/rest.js` -- Octokit REST API client, PR retrieval

### Secondary (MEDIUM confidence)
- Slack docs: `docs.slack.dev/reference/interaction-payloads/block_actions-payload` -- interactive payload structure
- Slack docs: `docs.slack.dev/reference/methods/chat.postMessage` -- message posting with blocks
- Linear docs: `linear.app/developers/sdk` -- SDK initialization and typed methods
- Linear docs: `linear.app/developers/attachments` -- attachment creation API

### Tertiary (LOW confidence)
- None. All claims verified against primary or secondary sources, or explicitly tagged as [ASSUMED].

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all package versions verified against npm registry; APIs confirmed via Context7
- Architecture: HIGH -- built on existing pipeline patterns (stage handlers, CDK constructs, Postgres schema) with well-documented external APIs
- Pitfalls: MEDIUM -- some pitfalls based on general Lambda/Slack experience, not project-specific testing

**Research date:** 2026-04-16
**Valid until:** 2026-05-16 (30 days -- APIs are stable; SDK versions may increment minor)

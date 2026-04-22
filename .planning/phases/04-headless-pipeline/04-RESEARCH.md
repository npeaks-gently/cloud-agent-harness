# Phase 4: Headless Pipeline - Research

**Researched:** 2026-04-17
**Domain:** Autonomous pipeline execution, LLM auto-decision agent, Slack escalation, CLI dispatch
**Confidence:** HIGH

## Summary

Phase 4 transforms the Cloud Agent Harness pipeline from requiring human interaction at decision points into a fully autonomous system where an LLM agent handles routine decisions and high-risk decisions escalate to Slack. The phase has three distinct workstreams: (1) an auto-decider agent that replaces the interactive questioning pattern with LLM-judged decisions, producing a DECISIONS.md audit trail; (2) risk escalation via the existing Phase 3 Slack approval flow; and (3) a `cah-dispatch` CLI script that bridges local questioning to cloud pipeline execution by uploading `.planning/` artifacts to S3 and sending an SQS message.

The existing codebase provides strong foundations. The `agent-entrypoint.ts` already uses `autoMode: true` with the SDK, `downloadPlanningDir()` and `uploadModifiedFiles()` handle S3 sync, and the Slack approval flow (Block Kit buttons, Postgres token, webhook Lambda) is fully operational from Phase 3. The primary engineering work is: extending `PipelineJobMessage` and `StageMessage` to carry a planning prefix, adding an `approval_type` discriminator to the `approvals` table, creating the auto-decider agent definition, adding a new `PhaseStepType.AutoDecide` to the SDK phase runner, and building the thin `cah-dispatch` CLI script.

**Primary recommendation:** Build incrementally on the proven Phase 3 patterns. The auto-decider agent is a new agent definition spawned via the same `query()` SDK pattern. Risk escalation reuses the existing Slack approval infrastructure with an `approval_type` discriminator. The CLI dispatch is a standalone script that composes existing S3 and SQS primitives.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Dedicated auto-decider agent spawned once per phase. New agent definition file (`agents/auto-decider.md`) following the existing agent-spawn pattern (gsd-executor, gsd-planner). Produces DECISIONS.md as its primary output artifact.
- **D-02:** Modular agent interface with clean input/output contract. Designed so future reviewer agents (v2 FEED-01 code review, FEED-02 verifier rejection loop) can plug into the same composable pattern.
- **D-03:** New `PhaseStepType.AutoDecide` enum value and `runAutoDecideStep` in PhaseRunner (~40 LOC) to orchestrate the agent spawn within the phase lifecycle.
- **D-04:** LLM-judged risk classification. Single Claude API call per decision with structured output: `{risk: 'high' | 'routine', reason: string}`. Context-aware, handles novel phrasings.
- **D-05:** Risk escalations go to the same Slack channel as plan approvals. Reuse existing Phase 3 approval flow (Block Kit buttons, Postgres approval token, SQS re-enqueue via webhook Lambda). No new Lambda, no new CDK construct.
- **D-06:** Add `approval_type` discriminator to the existing `approvals` table in Postgres (e.g., `'plan_approval'` vs `'risk_escalation'`).
- **D-07:** S3 file per phase: `runs/{run_id}/phases/{phase}/DECISIONS.md`. Same upload pattern as SUMMARY.md.
- **D-08:** One DECISIONS.md per phase directory (not per run), matching the existing S3 artifact key structure.
- **D-09:** Metadata per decision: question, chosen option, reasoning, confidence, risk level, alternatives considered. Human-readable Markdown format.
- **D-10:** Defer Postgres `decisions` table to Phase 5 if observability requirements surface a cross-run query need.
- **D-11:** Hybrid S3 upload approach. Local GSD questioning workflows remain completely unchanged.
- **D-12:** New `cah-dispatch` CLI script uploads local `.planning/` directory to S3 and sends a PipelineJobMessage to SQS with a `planningPrefix` field.
- **D-13:** Extend `PipelineJobMessage` with optional `planningPrefix?: string` field. Intake stage conditionally calls `downloadPlanningDir` when present.
- **D-14:** Pre-run S3 key structure: `triggers/{triggerId}/planning/` (before runId is assigned). Needs TTL/cleanup policy for stale triggers.

### Claude's Discretion
- Auto-decider agent prompt template and decision question format
- Risk classification prompt engineering (threshold calibration)
- DECISIONS.md Markdown layout and section structure
- `cah-dispatch` CLI argument design and error handling
- Pre-run S3 key cleanup strategy (TTL vs. explicit deletion)
- Approval type enum values and migration details
- How the auto-decider accesses sufficient context (which artifacts it reads)

### Deferred Ideas (OUT OF SCOPE)
- Postgres `decisions` table for cross-run querying -- promote from S3 file if Phase 5 observability surfaces the need
- Separate Slack escalation channel (#cah-escalations) -- add when team grows past ~3 people
- Static risk classification rules as a fast-path optimization -- add if LLM classification latency becomes a bottleneck
- Web-based interactive questioning phase (UX-02) -- v2, start with CLI
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PIPE-02 | Headless pipeline execution with no human interaction after initial questioning phase | D-11 through D-14 enable CLI-to-cloud handoff; auto-decider agent (D-01 through D-03) removes interactive decision points; existing `autoMode: true` in agent-entrypoint already enables non-interactive SDK sessions |
| PIPE-03 | Interaction abstraction replacing AskUserQuestion with LLM agent for autonomous decisions | D-01 auto-decider agent with D-04 LLM-judged risk classification replaces interactive questioning; D-05/D-06 escalation flow handles high-risk decisions; D-07 through D-09 provide audit trail |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Auto-decision agent | API / Backend (SDK + Daytona) | -- | LLM decisions execute server-side via `query()` in agent sandbox, not in browser |
| Risk classification | API / Backend (SDK) | -- | Single Claude API call per decision point, executed within agent session |
| Risk escalation to Slack | API / Backend (Lambda + Slack API) | -- | Reuses existing Phase 3 Lambda webhook + Slack Web API pattern |
| Approval type discrimination | Database / Storage (Postgres) | -- | Schema migration on `approvals` table; queried by webhook Lambda |
| DECISIONS.md audit trail | CDN / Static (S3) | API / Backend | Written locally by agent, uploaded to S3 via `uploadModifiedFiles()` |
| CLI dispatch (`cah-dispatch`) | Browser / Client (local CLI) | CDN / Static (S3) | Runs on developer machine; uploads to S3, sends SQS message |
| Pre-run S3 cleanup | CDN / Static (S3 lifecycle) | -- | S3 lifecycle rules or explicit deletion in intake handler |
| PhaseStepType.AutoDecide | API / Backend (SDK) | -- | New enum value and step runner in `sdk/src/phase-runner.ts` |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @anthropic-ai/claude-agent-sdk | ^0.2.84 (latest: 0.2.112) | Agent execution for auto-decider via `query()` | Already the project's execution backbone; all agents use it [VERIFIED: npm registry] |
| @slack/web-api | ^7.15.1 | Send risk escalation Block Kit messages | Already used in Phase 3 for plan approval messages [VERIFIED: package.json] |
| @aws-sdk/client-s3 | ^3.1030.0 | Upload `.planning/` from CLI, download in intake | Already used for all S3 operations in the pipeline [VERIFIED: package.json] |
| @aws-sdk/client-sqs | ^3.1030.0 | Send PipelineJobMessage from CLI dispatch | Already used by stage router for inter-stage messaging [VERIFIED: package.json] |
| pg | ^8.20.0 | Extend `approvals` table with `approval_type` column | Already the Postgres client for all pipeline state [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| posthog-node | ^5.21.2 | Track auto-decision events | Instrument decision counts, risk distribution, escalation rate [VERIFIED: package.json] |
| vitest | ^4.1.2 | Unit tests for all new modules | All new test files follow existing `vi.hoisted()` + `vi.mock()` pattern [VERIFIED: package.json] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| LLM-judged risk classification | Static keyword matching | Cheaper but brittle; misses novel phrasings, context nuance. D-04 explicitly chose LLM |
| Same Slack channel for escalations | Separate `#cah-escalations` channel | Simpler now; deferred per CONTEXT.md decision |
| S3 file per phase for decisions | Postgres `decisions` table | Deferred to Phase 5 per D-10 |

**Installation:**
No new packages required. All dependencies are already in `package.json`. [VERIFIED: package.json]

## Architecture Patterns

### System Architecture Diagram

```
[Developer CLI]
     |
     | 1. Run /gsd-discuss-phase locally (existing workflow, unchanged)
     v
[Local .planning/]
     |
     | 2. cah-dispatch uploads .planning/ to S3 + sends SQS message
     v
[S3: triggers/{triggerId}/planning/]  -->  [SQS Job Queue: PipelineJobMessage + planningPrefix]
                                                     |
                                                     v
                                            [Stage Router Lambda]
                                                     |
                                                     | 3. Intake detects planningPrefix, downloads from triggers/ prefix
                                                     v
                                            [Intake Stage Handler]
                                                     |
                                                     | 4. Normal pipeline flow: research -> plan -> approve -> execute -> verify -> pr
                                                     v
                                    [Research / Plan stages (Daytona agents)]
                                                     |
                                                     | 5. Auto-decider agent spawned per phase for routine decisions
                                                     v
                                            [Auto-Decide Step]
                                             /              \
                                     routine?                high-risk?
                                         |                       |
                                         v                       v
                              [Log to DECISIONS.md]    [Slack Escalation]
                              [Continue pipeline]       (reuse approve flow)
                                                             |
                                                             v
                                                    [Slack Block Kit buttons]
                                                    [Webhook -> SQS resume]
                                                             |
                                                             v
                                              [Execute -> Verify -> PR stages]
                                                             |
                                                             v
                                                    [PR Delivered]
```

### Recommended Project Structure
```
src/cloud/
  types.ts                          # Extend PipelineJobMessage with planningPrefix
  postgres-client.ts                # Add approval_type-aware queries
  pipeline/
    types.ts                        # (no changes needed)
    stage-router.ts                 # (no changes -- routing is by stage enum)
    stages/
      intake.ts                     # Extend: conditional downloadPlanningDir from triggers/ prefix
      approve.ts                    # Extend: pass approval_type to insertApproval
  integrations/
    slack.ts                        # Add sendEscalationMessage() alongside sendApprovalMessage()
  webhook/
    slack-handler.ts                # Extend action_id handling for escalation_approve/reject
  entrypoint/
    agent-entrypoint.ts             # Add 'auto-decide' case to stage switch
  dispatch/
    cah-dispatch.ts                 # NEW: CLI script for S3 upload + SQS send
  test/
    auto-decider.test.ts            # NEW
    cah-dispatch.test.ts            # NEW
    escalation.test.ts              # NEW
    intake-planning.test.ts         # NEW
agents/
  auto-decider.md                   # NEW: Agent definition for auto-decision making
sdk/src/
  types.ts                          # Add PhaseStepType.AutoDecide enum value
  phase-runner.ts                   # Add runAutoDecideStep (~40 LOC)
scripts/
  migrate-004-approval-type.sql     # NEW: Add approval_type to approvals table
infra/lib/
  cah-stack.ts                      # (no CDK changes needed per D-05)
```

### Pattern 1: Auto-Decider Agent Definition
**What:** A Markdown agent definition file following the existing YAML frontmatter pattern used by gsd-executor, gsd-planner, etc.
**When to use:** Spawned once per phase during the auto-decide step.
**Example:**
```markdown
---
name: auto-decider
description: Makes routine decisions autonomously and escalates high-risk decisions to Slack. Produces DECISIONS.md audit trail.
tools: Read, Bash, Grep, Glob
color: cyan
---
# Source: Existing agent definition pattern from agents/gsd-executor.md [VERIFIED: codebase]

<role>
You are an autonomous decision-making agent. When the pipeline encounters
a decision point that would normally require human input, you evaluate
the decision and either make it (routine) or escalate it (high-risk).

Your outputs:
1. DECISIONS.md -- audit trail of all decisions made this phase
2. Structured JSON on stdout for each decision: {risk, decision, reason}
</role>
```

### Pattern 2: Risk Classification via Structured Output
**What:** LLM-judged risk classification using a single Claude API call with structured output parsing.
**When to use:** Each time the auto-decider encounters a decision point during pipeline execution.
**Example:**
```typescript
// Source: D-04 from CONTEXT.md, pattern from session-runner.ts [VERIFIED: codebase]

interface RiskClassification {
  risk: 'high' | 'routine';
  reason: string;
  confidence: number;
}

// The auto-decider agent prompt includes instructions to classify risk.
// The agent reads the decision context (CONTEXT.md, RESEARCH.md, plan files)
// and outputs structured JSON that the phase runner parses.
// High-risk triggers: architecture changes, new dependencies, scope changes,
// security-sensitive decisions, cost-impacting decisions.
```

### Pattern 3: Approval Type Discrimination
**What:** Extending the existing `approvals` table with an `approval_type` column to distinguish plan approvals from risk escalations.
**When to use:** When inserting or querying approvals in both the approve stage and risk escalation flow.
**Example:**
```sql
-- Source: migrate-003-approvals.sql pattern [VERIFIED: codebase]
-- Migration 004: Add approval_type discriminator (D-06)
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approval_type TEXT NOT NULL DEFAULT 'plan_approval';

-- The existing approvals rows all become 'plan_approval' (backward compatible).
-- Risk escalations insert with approval_type = 'risk_escalation'.
```

### Pattern 4: CLI Dispatch (cah-dispatch)
**What:** A thin CLI script that uploads the local `.planning/` directory to S3 under a `triggers/{triggerId}` prefix and sends a PipelineJobMessage to SQS.
**When to use:** After the developer completes the interactive questioning phase locally.
**Example:**
```typescript
// Source: D-11 through D-14, pattern from s3-sync.ts [VERIFIED: codebase]

// 1. Generate a triggerId (UUID)
// 2. Walk .planning/ directory, upload each file to S3:
//    s3://bucket/triggers/{triggerId}/planning/{relativePath}
// 3. Send PipelineJobMessage to SQS with planningPrefix field:
//    { projectId, repoUrl, branch, featureDescription, planningPrefix: `triggers/${triggerId}/planning/` }
// 4. Print triggerId for tracking
```

### Pattern 5: Intake Stage Extension for Planning Download
**What:** Conditionally downloading pre-uploaded `.planning/` artifacts when `planningPrefix` is present in the StageMessage context.
**When to use:** During the intake stage when a `cah-dispatch`-triggered run arrives.
**Example:**
```typescript
// Source: s3-sync.ts downloadPlanningDir() [VERIFIED: codebase]
// Source: intake.ts handleIntakeStage() [VERIFIED: codebase]

// In handleIntakeStage, after creating the pipeline_run:
// if (msg.context.planningPrefix) {
//   await downloadFromPrefix(bucket, msg.context.planningPrefix, WORK_DIR, s3);
//   // Then re-upload to runs/{runId}/planning/ for the standard path
//   await copyToRunPrefix(bucket, msg.context.planningPrefix, msg.runId, s3);
// }
```

### Anti-Patterns to Avoid
- **Polling for Slack responses:** The existing Phase 3 pattern uses webhook callbacks, not polling. Risk escalation MUST follow the same pattern (paused status, webhook resume). [VERIFIED: approve.ts, slack-handler.ts]
- **Separate Lambda for escalation:** D-05 explicitly prohibits new Lambdas. Reuse the existing webhook Lambda with extended action_id handling. [VERIFIED: CONTEXT.md D-05]
- **Mixing auto-decide into stage handlers:** Auto-decide is an SDK-level step (PhaseStepType.AutoDecide) that runs within the agent sandbox, not a pipeline stage handler in the router Lambda. [VERIFIED: CONTEXT.md D-03]
- **Blocking pipeline on every decision:** The auto-decider processes all routine decisions in a single batch per phase. Only high-risk decisions pause the pipeline. [ASSUMED]
- **Hardcoded risk keywords:** D-04 chose LLM-judged classification over static keyword matching. Do not implement a keyword allowlist/blocklist as the primary classifier. [VERIFIED: CONTEXT.md D-04]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack message formatting | Custom string concatenation | Block Kit builder from `@slack/web-api` | Block Kit types are validated at send time; raw JSON is fragile [VERIFIED: existing slack.ts pattern] |
| S3 directory upload | Recursive file walker + individual puts | Reuse `uploadModifiedFiles()` pattern from `s3-sync.ts` | Already handles path construction, checksum verification [VERIFIED: s3-sync.ts] |
| UUID generation | Custom ID scheme | `crypto.randomUUID()` | Already used for all IDs in the project (run IDs, approval tokens) [VERIFIED: stage-router.ts, approve.ts] |
| SQS message sending | Direct AWS SDK boilerplate | Wrap in function following `routeStage()` pattern | Error handling, JSON serialization, queue URL resolution already patterned [VERIFIED: stage-router.ts] |
| Postgres schema migration | Inline ALTER TABLE in code | SQL migration file per `scripts/migrate-NNN-*.sql` convention | Matches existing migration chain (001, 002, 003) [VERIFIED: scripts/] |
| Agent prompt building | Inline string templates | Agent definition MD file + `PromptFactory.buildPrompt()` pattern | All other agents use this pattern; supports tool scoping, context injection [VERIFIED: phase-runner.ts] |

**Key insight:** Nearly every component of Phase 4 is a composition of existing patterns. The auto-decider is a new agent following the executor pattern. Risk escalation is the approval flow with a different `approval_type`. The CLI dispatch composes S3 upload + SQS send. The value is in wiring, not invention.

## Common Pitfalls

### Pitfall 1: Escalation Deadlock
**What goes wrong:** The pipeline pauses for a risk escalation Slack approval, but the webhook Lambda doesn't know how to resume it because the action_id is unrecognized.
**Why it happens:** The webhook handler currently only accepts `pipeline_approve` and `pipeline_reject` action_ids. New escalation action_ids must be added.
**How to avoid:** Extend the webhook handler's action_id allowlist AND test the full roundtrip: escalation message -> Slack button click -> webhook -> SQS resume.
**Warning signs:** Tests mock the webhook handler but don't test with actual escalation action_ids.

### Pitfall 2: StageMessage Context Loss
**What goes wrong:** The `planningPrefix` field is present in `PipelineJobMessage` but gets lost during the `jobMessageToIntakeStageMessage()` conversion, so the intake handler never downloads the pre-uploaded planning directory.
**Why it happens:** `jobMessageToIntakeStageMessage()` manually constructs the `context` object and doesn't forward the `planningPrefix` field.
**How to avoid:** Extend `StageMessage.context` with `planningPrefix?: string` and ensure `jobMessageToIntakeStageMessage()` copies it through. Add a unit test that verifies the field survives the conversion.
**Warning signs:** `cah-dispatch` seems to work (SQS message accepted) but the pipeline starts from scratch without the uploaded planning context.

### Pitfall 3: Auto-Decider Over-Classification as High-Risk
**What goes wrong:** The LLM risk classifier is too conservative and escalates nearly everything to Slack, defeating the purpose of autonomous execution.
**Why it happens:** Without prompt engineering and few-shot examples, LLMs default to caution. Every novel decision looks potentially "high-risk."
**How to avoid:** Include concrete examples of routine vs. high-risk decisions in the auto-decider prompt. Provide a default-routine bias: "When in doubt, classify as routine and log with lower confidence."
**Warning signs:** PostHog events show >30% of decisions being escalated to Slack.

### Pitfall 4: S3 Trigger Prefix Orphan Accumulation
**What goes wrong:** Failed or abandoned `cah-dispatch` invocations leave `.planning/` artifacts in `triggers/{triggerId}/planning/` indefinitely, accumulating storage costs.
**Why it happens:** The trigger prefix is created before a pipeline run exists, so there's no run lifecycle to clean it up.
**How to avoid:** Implement either (a) S3 lifecycle rule with 7-day TTL on `triggers/` prefix, or (b) explicit cleanup in intake handler after successful copy to `runs/{runId}/planning/`.
**Warning signs:** S3 bucket size grows faster than expected; many `triggers/` prefixes with no corresponding pipeline run.

### Pitfall 5: Approval Type Backward Incompatibility
**What goes wrong:** Existing approval rows (from Phase 3 plan approvals) cause query failures because they don't have the `approval_type` column or have NULL values.
**Why it happens:** Migration adds the column but doesn't consider whether existing queries filter by it.
**How to avoid:** Use `DEFAULT 'plan_approval'` in the migration so all existing rows are automatically classified. Ensure queries use `approval_type = 'plan_approval'` only when explicitly filtering, not as a mandatory WHERE clause.
**Warning signs:** Existing Phase 3 approval tests start failing after the migration is applied.

### Pitfall 6: CLI Dispatch Missing Credentials
**What goes wrong:** `cah-dispatch` fails silently or with cryptic AWS SDK errors because the developer doesn't have the right AWS credentials configured locally.
**Why it happens:** The pipeline infrastructure uses IAM roles, but the CLI runs on a developer machine which needs explicit credentials (AWS profile or env vars).
**How to avoid:** Check for AWS credentials at script startup and fail with a clear message: "AWS credentials not found. Set AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY."
**Warning signs:** "CredentialsProviderError" in stderr output.

## Code Examples

Verified patterns from the existing codebase:

### Migration 004: Add approval_type to approvals table
```sql
-- Source: Pattern from scripts/migrate-003-approvals.sql [VERIFIED: codebase]
-- Cloud Agent Harness -- Migration 004: Approval type discriminator
-- Run: psql "$DATABASE_URL" -f scripts/migrate-004-approval-type.sql

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approval_type TEXT NOT NULL DEFAULT 'plan_approval';

-- Index for filtering approvals by type (webhook handler may need this for routing)
CREATE INDEX IF NOT EXISTS idx_approvals_type ON approvals(approval_type);
```

### Extending PipelineJobMessage with planningPrefix
```typescript
// Source: src/cloud/types.ts [VERIFIED: codebase]
export interface PipelineJobMessage {
  projectId: string;
  repoUrl: string;
  branch: string;
  featureDescription: string;
  config?: Record<string, unknown>;
  /** S3 key prefix where pre-uploaded .planning/ artifacts are stored (D-13) */
  planningPrefix?: string;
}
```

### Extending StageMessage context with planningPrefix
```typescript
// Source: src/cloud/pipeline/types.ts StageMessage.context [VERIFIED: codebase]
context: {
  featureDescription: string;
  phaseNumber: number;
  phaseTotal: number;
  previousArtifacts: string[];
  featureBranch?: string;
  linearParentTicketId?: string;
  /** S3 key prefix for pre-uploaded planning context (D-13) */
  planningPrefix?: string;
};
```

### Adding PhaseStepType.AutoDecide to SDK
```typescript
// Source: sdk/src/types.ts PhaseStepType enum [VERIFIED: codebase]
export enum PhaseStepType {
  Discuss = 'discuss',
  Research = 'research',
  Plan = 'plan',
  PlanCheck = 'plan_check',
  AutoDecide = 'auto_decide',  // NEW (D-03)
  Execute = 'execute',
  Verify = 'verify',
  Advance = 'advance',
}
```

### sendEscalationMessage() for risk escalation
```typescript
// Source: Pattern from src/cloud/integrations/slack.ts sendApprovalMessage() [VERIFIED: codebase]
export async function sendEscalationMessage(
  channel: string,
  runId: string,
  projectId: string,
  approvalToken: string,
  decisionSummary: string,
  riskReason: string,
): Promise<string> {
  const token = await getSlackBotToken();
  const client = new WebClient(token);

  const result = await client.chat.postMessage({
    channel,
    text: `Risk escalation for run ${runId}: ${riskReason}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Risk Escalation' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Run:* \`${runId}\`\n*Project:* \`${projectId}\`\n*Risk:* ${riskReason}\n\n${decisionSummary}`,
        },
      },
      {
        type: 'actions',
        block_id: `escalation_${approvalToken}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve Decision' },
            style: 'primary',
            action_id: 'escalation_approve',
            value: approvalToken,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reject Decision' },
            style: 'danger',
            action_id: 'escalation_reject',
            value: approvalToken,
          },
        ],
      },
    ],
  });

  return result.ts ?? '';
}
```

### Webhook Handler Extension for Escalation Actions
```typescript
// Source: src/cloud/webhook/slack-handler.ts action handling [VERIFIED: codebase]
// Extend the action_id check from:
//   ['pipeline_approve', 'pipeline_reject']
// to:
//   ['pipeline_approve', 'pipeline_reject', 'escalation_approve', 'escalation_reject']
//
// The approval token lookup and SQS resume logic is identical.
// The only difference: escalation_approve resumes at the SAME stage (auto-decide step
// within the agent), not the NEXT_STAGE. This requires the StageMessage to carry
// enough context for the auto-decider to continue from where it paused.
```

### DECISIONS.md Format
```markdown
# Decisions -- Phase {N}

**Run:** {run_id}
**Phase:** {phase_number}
**Generated:** {timestamp}

## Decision 1: {question}

| Field | Value |
|-------|-------|
| Risk Level | routine |
| Confidence | 0.9 |
| Chosen Option | {option} |
| Alternatives | {alt1}, {alt2} |

**Reasoning:** {why this option was chosen}

---
```

### cah-dispatch CLI Script
```typescript
// Source: Pattern from s3-sync.ts + types.ts [VERIFIED: codebase]
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function dispatch(options: {
  projectDir: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  featureDescription: string;
  bucket: string;
  queueUrl: string;
}): Promise<string> {
  const triggerId = randomUUID();
  const s3 = new S3Client({ region: 'us-east-1' });
  const sqs = new SQSClient({ region: 'us-east-1' });

  // 1. Upload .planning/ to S3 under triggers/{triggerId}/planning/
  const planningDir = join(options.projectDir, '.planning');
  const files = await walkDir(planningDir);
  for (const filePath of files) {
    const relativePath = relative(planningDir, filePath);
    const key = `triggers/${triggerId}/planning/${relativePath}`;
    const content = await readFile(filePath);
    await s3.send(new PutObjectCommand({
      Bucket: options.bucket,
      Key: key,
      Body: content,
    }));
  }

  // 2. Send PipelineJobMessage to SQS
  const message = {
    projectId: options.projectId,
    repoUrl: options.repoUrl,
    branch: options.branch,
    featureDescription: options.featureDescription,
    planningPrefix: `triggers/${triggerId}/planning/`,
  };
  await sqs.send(new SendMessageCommand({
    QueueUrl: options.queueUrl,
    MessageBody: JSON.stringify(message),
  }));

  return triggerId;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Interactive AskUserQuestion prompts | LLM auto-decision with risk escalation | Phase 4 (this phase) | Enables fully headless pipeline execution |
| Human-only plan approval | Plan approval + risk escalation both via Slack | Phase 4 (this phase) | Dual approval type requires `approval_type` discriminator |
| Pipeline requires pre-existing `.planning/` in repo | CLI dispatch uploads `.planning/` to S3 | Phase 4 (this phase) | Decouples questioning phase from cloud execution |

**Deprecated/outdated:**
- `auto-approve` placeholder in `agent-entrypoint.ts` for the `'approve'` case: Will remain as-is since the approve stage is handled by the approve stage handler Lambda, not the sandbox entrypoint. [VERIFIED: agent-entrypoint.ts line 281]

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research. The planner and discuss-phase use this
> section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Auto-decider processes all routine decisions in a single batch per phase rather than being invoked per-decision | Anti-Patterns | If decisions must be made interactively during execution (not pre-collected), the auto-decide step placement in the lifecycle needs rethinking |
| A2 | Escalation resume returns to the same pipeline stage (not NEXT_STAGE) | Code Examples (Webhook Handler Extension) | If escalation pauses the entire pipeline at a stage boundary, the resume logic needs different StageMessage construction |
| A3 | The `cah-dispatch` script runs as a standalone CLI entry point (not integrated into the GSD command system) | Architecture Patterns | If it should be a GSD command, the implementation approach changes |
| A4 | S3 lifecycle rule with 7-day TTL is the preferred cleanup strategy for stale trigger prefixes | Pitfalls (Pitfall 4) | If explicit cleanup is preferred, intake handler needs deletion logic |

## Open Questions

1. **Auto-decide step placement in the phase lifecycle**
   - What we know: D-03 says `PhaseStepType.AutoDecide` and `runAutoDecideStep` in PhaseRunner. The current lifecycle is: discuss -> research -> plan -> plan_check -> execute -> verify -> advance.
   - What's unclear: Where exactly does auto-decide fit? Before discuss (to make decisions that would have been interactive)? Between plan and execute (to resolve implementation decisions)? Or at every step boundary?
   - Recommendation: Place auto-decide between plan_check and execute. This is the natural decision point where implementation choices are made. The auto-decider reads the approved plan and makes all routine implementation decisions upfront, logging them to DECISIONS.md. High-risk decisions escalate before execution begins.

2. **Escalation resume mechanism**
   - What we know: Plan approval uses a "pause pipeline, wait for webhook callback, re-enqueue next stage" pattern. D-05 says reuse this flow.
   - What's unclear: When a risk escalation pauses the pipeline, should it resume at the same stage or advance? The auto-decide step runs within a Daytona agent, not as a pipeline stage -- so the existing stage-level pause/resume may not apply directly.
   - Recommendation: Risk escalation pauses the pipeline at the stage level (similar to approve stage). The auto-decider agent writes a "pending escalation" marker, returns a special result status, and the stage handler uses the existing pause/resume mechanism. When approved via Slack, the pipeline re-enters the stage and the auto-decider picks up where it left off (reads DECISIONS.md to see what's already decided, processes remaining decisions).

3. **Context available to the auto-decider**
   - What we know: D-02 mentions modular agent interface with clean input/output contract. The agent reads phase context.
   - What's unclear: Exactly which files does the auto-decider read to make informed decisions? CONTEXT.md (user constraints), RESEARCH.md (technology findings), plan files (implementation details)?
   - Recommendation: The auto-decider reads CONTEXT.md, RESEARCH.md, and all plan files for the current phase. It identifies decision points by analyzing ambiguities or unresolved questions in the plans, and makes or escalates each one.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All TypeScript execution | Yes | v22.18.0 | -- |
| npm | Package management | Yes | 10.9.3 | -- |
| TypeScript | Type checking | Yes | 6.0.2 | -- |
| AWS CLI | cah-dispatch credentials | Needs verification | -- | SDK credential chain (env vars, shared credentials file) |
| Vitest | Test execution | Yes | 4.1.4 | -- |

**Missing dependencies with no fallback:**
- None identified. All required tools are present.

**Missing dependencies with fallback:**
- AWS CLI is optional for `cah-dispatch`; the AWS SDK credential chain handles authentication through env vars or shared credentials file without requiring the CLI.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 |
| Config file | `vitest.config.ts` (root, with `cloud-unit` project) |
| Quick run command | `npx vitest run --project cloud-unit` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PIPE-02-a | cah-dispatch uploads .planning/ to S3 and sends SQS message | unit | `npx vitest run src/cloud/test/cah-dispatch.test.ts -x` | Wave 0 |
| PIPE-02-b | Intake stage downloads planning from trigger prefix when planningPrefix present | unit | `npx vitest run src/cloud/test/intake-planning.test.ts -x` | Wave 0 |
| PIPE-02-c | PipelineJobMessage.planningPrefix field survives jobMessageToIntakeStageMessage conversion | unit | `npx vitest run src/cloud/test/stage-router.test.ts -x` | Existing (extend) |
| PIPE-03-a | Auto-decider agent produces DECISIONS.md with correct metadata per decision | unit | `npx vitest run src/cloud/test/auto-decider.test.ts -x` | Wave 0 |
| PIPE-03-b | Risk classification returns {risk, reason} structured output | unit | `npx vitest run src/cloud/test/auto-decider.test.ts -x` | Wave 0 |
| PIPE-03-c | High-risk decisions send Slack escalation message with Block Kit buttons | unit | `npx vitest run src/cloud/test/escalation.test.ts -x` | Wave 0 |
| PIPE-03-d | Escalation approval resumes pipeline via SQS (webhook handler extended) | unit | `npx vitest run src/cloud/test/slack-webhook.test.ts -x` | Existing (extend) |
| PIPE-03-e | approval_type column defaults to 'plan_approval' for existing rows | unit | `npx vitest run src/cloud/test/approve.test.ts -x` | Existing (extend) |
| PIPE-03-f | PhaseStepType.AutoDecide step runs within PhaseRunner lifecycle | unit | `npx vitest run sdk/src/phase-runner.test.ts -x` | Existing (extend) |

### Sampling Rate
- **Per task commit:** `npx vitest run --project cloud-unit`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/cloud/test/cah-dispatch.test.ts` -- covers PIPE-02-a
- [ ] `src/cloud/test/intake-planning.test.ts` -- covers PIPE-02-b
- [ ] `src/cloud/test/auto-decider.test.ts` -- covers PIPE-03-a, PIPE-03-b
- [ ] `src/cloud/test/escalation.test.ts` -- covers PIPE-03-c

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | CLI dispatch uses AWS IAM credentials (existing AWS SDK credential chain) |
| V3 Session Management | No | Pipeline sessions are stateless per-Lambda invocations |
| V4 Access Control | Yes | Slack webhook HMAC-SHA256 signature verification (already implemented); approval token validation for escalation actions |
| V5 Input Validation | Yes | Validate PipelineJobMessage schema including new planningPrefix field; validate cah-dispatch CLI arguments |
| V6 Cryptography | No | Existing patterns (HMAC-SHA256, UUIDv4 tokens) already cover needs |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malicious planning artifacts uploaded via cah-dispatch | Tampering | Validate file types and sizes in intake handler; S3 bucket policy restricts uploads to IAM-authenticated users |
| Forged Slack webhook payload for escalation approval | Spoofing | Existing HMAC-SHA256 verification + 5-min replay window in slack-handler.ts [VERIFIED: codebase] |
| Token reuse for escalation after resolution | Tampering | Existing `WHERE status = 'pending'` guard in resolveApproval() prevents double-resolution [VERIFIED: postgres-client.ts] |
| Prompt injection via planningPrefix S3 key | Tampering | Validate that planningPrefix matches expected format `triggers/{uuid}/planning/`; reject traversal characters |
| Auto-decider making security-sensitive decisions routinely | Elevation of Privilege | Include security-related keywords in high-risk classification criteria; architecture changes, auth changes, and dependency additions must always escalate |

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `src/cloud/types.ts`, `src/cloud/pipeline/types.ts`, `src/cloud/pipeline/stage-router.ts`, `src/cloud/pipeline/stages/approve.ts`, `src/cloud/pipeline/stages/intake.ts`, `src/cloud/integrations/slack.ts`, `src/cloud/webhook/slack-handler.ts`, `src/cloud/postgres-client.ts`, `src/cloud/entrypoint/agent-entrypoint.ts`, `src/cloud/entrypoint/s3-sync.ts`, `src/cloud/analytics.ts`
- SDK inspection: `sdk/src/types.ts`, `sdk/src/phase-runner.ts`, `sdk/src/session-runner.ts`
- Database schema: `scripts/init-db-schema.sql`, `scripts/migrate-002-idempotency.sql`, `scripts/migrate-003-approvals.sql`
- CDK stack: `infra/lib/cah-stack.ts`
- Agent definitions: `agents/gsd-executor.md`, `agents/gsd-planner.md`
- npm registry: `@anthropic-ai/claude-agent-sdk` version 0.2.112, `@slack/web-api` version 7.15.1
- `package.json`: All dependency versions verified

### Secondary (MEDIUM confidence)
- `.planning/CONTEXT.md` decisions (D-01 through D-14): User-approved design decisions
- `.planning/REQUIREMENTS.md`: PIPE-02 and PIPE-03 requirement definitions
- `.planning/ROADMAP.md`: Phase 4 success criteria

### Tertiary (LOW confidence)
- None. All findings are based on codebase inspection and user decisions.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in package.json, verified against npm registry
- Architecture: HIGH - All patterns directly extend existing proven codebase patterns (Phase 2/3 stage handlers, approval flow, S3 sync)
- Pitfalls: HIGH - Identified from direct codebase analysis (type guard gaps, migration compatibility, credential handling)
- Auto-decider prompt design: MEDIUM - LLM risk classification is the only novel component without existing codebase precedent

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (30 days -- stable domain, no fast-moving external dependencies)

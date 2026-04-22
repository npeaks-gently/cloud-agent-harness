# Phase 3: Integrations - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect the pipeline to four external systems: Slack for plan approval (replacing the auto-approve placeholder), GitHub for PR delivery (replacing the PR stage placeholder), Linear for ticket tracking across the pipeline lifecycle, and PostHog for event instrumentation. Each integration plugs into existing pipeline stages from Phase 2.

</domain>

<decisions>
## Implementation Decisions

### Slack Approval (INTG-01)
- **D-01:** Postgres token re-enqueue pattern. The approve stage writes a pending-approval row with a UUID token to a new `approvals` table in Postgres, then returns `status: 'paused'` without advancing the SQS pipeline.
- **D-02:** A new Slack webhook Lambda (behind API Gateway) receives the Slack button callback, validates the token against Postgres, marks the approval as accepted/rejected, and sends the next-stage SQS message to resume the pipeline on approval.
- **D-03:** The stage-router must handle `status: 'paused'` as a terminal state for the approve stage (no NEXT_STAGE advancement). The Slack webhook Lambda is responsible for re-enqueuing.
- **D-04:** Slack message uses Block Kit with approve/reject buttons. The message includes the plan summary and pipeline context so the user can make an informed decision without leaving Slack.

### Git/PR Delivery (INTG-02)
- **D-05:** Feature branch created at intake stage. Intake Lambda creates a feature branch (e.g., `cah/{run_id_short}/{feature-slug}`) and records it in the `pipeline_runs` table. All downstream stages read the feature branch name from StageMessage context.
- **D-06:** Branch-per-task pattern. Each agent in a Daytona sandbox clones the repo, checks out the feature branch, creates a task-specific branch (e.g., `cah/{run_id}/{phase}-{plan}-{wave}`), commits normally, and pushes to remote.
- **D-07:** Integration executor merges task branches back into the feature branch in wave-DAG order after all agents in a wave complete. This mirrors the local GSD harness worktree merge pattern — orchestrator-owned file protection, conflict detection, and post-merge test gate apply.
- **D-08:** PR stage opens a pull request from the feature branch to main with a structured description summarizing all phases, plans, and agent task outcomes.

### Linear Tracking (INTG-03)
- **D-09:** Pipeline-created tickets. Intake stage creates a parent Linear ticket for the pipeline run. No upstream webhook dependency — the pipeline is self-contained.
- **D-10:** Sub-ticket per phase. Each phase creates a sub-ticket linked to the parent via Linear's `parentId` on `issueCreate`. Stage transitions update the active phase's sub-ticket status.
- **D-11:** PR URL linked to the parent ticket on completion via Linear's `attachmentCreate` API. Parent ticket marked done when the PR is opened.

### PostHog Instrumentation (INTG-04)
- **D-12:** Thin PostHog utility file (`src/cloud/analytics.ts`, ~20-30 lines) wrapping `posthog-node` client initialization, a `track()` helper for consistent event structure, and a `flush()` function for Lambda shutdown.
- **D-13:** Each stage Lambda imports the utility and calls `track()` directly. No heavyweight abstraction — just consistent client init and event shape in one place.
- **D-14:** Event name conventions documented (not enforced by typed functions). Consistent naming like `pipeline_started`, `phase_transition`, `agent_run_completed`, `approval_requested`, `pr_created`. Planner defines the full event taxonomy during planning.

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Context
- `.planning/PROJECT.md` -- Project vision, constraints (AWS, solo team, managed services), key decisions
- `.planning/REQUIREMENTS.md` -- INTG-01 through INTG-04 requirements for this phase
- `.planning/ROADMAP.md` -- Phase 3 success criteria (4 criteria that must be TRUE)

### Phase 1 Foundation (Infrastructure)
- `infra/lib/cah-stack.ts` -- CDK stack with all AWS resources (VPC, S3, RDS, SQS, IAM)
- `src/cloud/types.ts` -- Domain types: PipelineRun, AgentRun, PipelineJobMessage, AgentTaskConfig
- `src/cloud/postgres-client.ts` -- Postgres client (will need new approvals table queries)
- `src/cloud/sqs-consumer.ts` -- SQS consumer for pipeline job messages

### Phase 2 Foundation (Pipeline Stages)
- `src/cloud/pipeline/types.ts` -- PipelineStage enum, StageMessage, StageResult, NEXT_STAGE map
- `src/cloud/pipeline/stages/approve.ts` -- Auto-approve placeholder to be replaced with Slack integration
- `src/cloud/pipeline/stages/pr.ts` -- PR stage placeholder to be replaced with git/PR delivery
- `src/cloud/pipeline/stages/intake.ts` -- Intake handler (will be extended with feature branch + Linear ticket creation)
- `src/cloud/pipeline/stage-router.ts` -- Stage router (must handle 'paused' status for approval gate)
- `src/cloud/pipeline/idempotency.ts` -- Idempotency module (external writes use run_id:phase:plan:wave keys)
- `src/cloud/entrypoint/agent-entrypoint.ts` -- Agent entrypoint script (will need git push capability)

### Local Harness Parallel Execution (Pattern Reference)
- `get-shit-done/workflows/execute-phase.md` -- Wave execution, worktree merge, orchestrator-owned file protection
- `get-shit-done/workflows/execute-plan.md` -- Parallel vs sequential commit patterns, worktree detection

### Prior Phase Context
- `.planning/phases/01-aws-foundation-agent-runtime/01-CONTEXT.md` -- Infrastructure decisions (D-01 through D-15)
- `.planning/phases/02-pipeline-orchestration-state-management/02-CONTEXT.md` -- Pipeline decisions (D-01 through D-19)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/cloud/pipeline/stages/approve.ts` -- Auto-approve placeholder with correct function signature. Replace internals with Slack message send + Postgres token write
- `src/cloud/pipeline/stages/pr.ts` -- PR stage placeholder with correct function signature. Replace internals with git assembly + PR creation
- `src/cloud/pipeline/stages/intake.ts` -- Already creates pipeline_runs row. Extend with feature branch creation and Linear parent ticket creation
- `src/cloud/pipeline/idempotency.ts` -- Idempotency module for external writes. Slack messages, Linear updates, and PR creation should use idempotency keys
- `src/cloud/postgres-client.ts` -- Existing Postgres client. Needs new functions for approvals table CRUD

### Established Patterns
- Stage handlers follow consistent signature: `(msg: StageMessage, pool: Pool) => Promise<StageResult>`
- CloudWatch structured JSON logging via `console.log(JSON.stringify({...}))`
- Idempotency via `ON CONFLICT` in Postgres and deterministic task keys
- CDK infrastructure in `infra/lib/cah-stack.ts` -- new resources (API Gateway, webhook Lambda) added here

### Integration Points
- `src/cloud/pipeline/stage-router.ts` -- Must handle `status: 'paused'` for approval gate (currently only handles completed/failed/skipped)
- `src/cloud/pipeline/types.ts` -- StageMessage.context may need feature branch name and Linear ticket IDs added
- `src/cloud/entrypoint/agent-entrypoint.ts` -- Agents need git push permissions and task branch creation
- `infra/lib/cah-stack.ts` -- New CDK constructs: API Gateway for Slack webhook, Lambda for webhook handler

</code_context>

<specifics>
## Specific Ideas

- Approval pause mirrors local GSD's AskUserQuestion pattern -- pipeline pauses, external system (Slack) provides the answer, pipeline resumes
- Git branch-per-task + integration executor directly mirrors the local worktree merge pattern: worktrees become Daytona sandboxes, worktree branches become task branches, post-wave merge becomes integration executor
- Linear parent + sub-ticket hierarchy mirrors the harness's own pipeline run + phase structure
- PostHog utility intentionally kept thin -- just client init, track(), flush(). Can grow if needed but starts minimal

</specifics>

<deferred>
## Deferred Ideas

- Linear webhook triggering pipeline runs (ticket-triggered flow) -- revisit if team wants Linear as the entry point rather than Slack/CLI
- Hybrid Linear upsert (accept optional ticketId) -- add if pipeline gets multiple entry paths that may already have tickets
- Step Functions for approval gate -- revisit if visual debugging of the approval flow becomes necessary
- Lambda Durable Functions -- revisit when the feature matures past Dec 2025 launch

</deferred>

---

*Phase: 03-integrations*
*Context gathered: 2026-04-16*

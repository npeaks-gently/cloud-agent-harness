# Phase 3: Integrations - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md -- this log preserves the alternatives considered.

**Date:** 2026-04-16
**Phase:** 03-integrations
**Areas discussed:** Approval pause mechanism, Git commit accumulation, Linear ticket lifecycle, PostHog instrumentation

---

## Approval Pause Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Postgres token re-enqueue | Approve stage writes pending row + UUID token to Postgres, returns 'paused'. Slack webhook Lambda validates token and sends next-stage SQS message. Fits existing architecture. | ✓ |
| Lambda Durable Functions | Replace stage-router with Durable Function; handleApproveStage calls ctx.waitForCallback(). Clean semantics but CDK resource replacement risk and Dec 2025 feature maturity. | |
| Step Functions for approval only | Route plan->approve through a Step Functions workflow with .waitForTaskToken. Contradicts D-01/D-04 and adds a second orchestration model. | |

**User's choice:** Postgres token re-enqueue
**Notes:** Selected as recommended option. Fits existing Lambda+SQS+Postgres architecture without introducing new orchestration models or immature AWS features.

---

## Git Commit Accumulation

| Option | Description | Selected |
|--------|-------------|----------|
| Orchestrator-driven S3-to-git | PR stage Lambda reads S3 artifacts in wave-DAG order, applies to local clone, commits with task metadata. | |
| Agents push directly to branch | Each agent does git push from sandbox. Simplest but push conflicts with parallel waves. | |
| Hybrid cherry-pick | Agents commit locally, export patches to S3, orchestrator cherry-picks in sequence. | |
| Branch-per-task + integration executor | Agents create task branches, commit, push. Integration executor merges in wave-DAG order. (User-proposed) | ✓ |

**User's choice:** Branch-per-task with integration executor (user-proposed approach)
**Notes:** User asked how local GSD handles parallel execution. After reviewing the worktree merge pattern, proposed a cloud analog: agents clone the feature branch, create task-specific branches, commit and push. An integration executor merges task branches back into the feature branch in wave-DAG order -- directly mirroring the local worktree merge. Feature branch created at intake stage and stored in pipeline_runs.

---

## Linear Ticket Lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Ticket-triggered pipeline | Linear webhook fires pipeline with ticketId. Pipeline updates originating ticket at each stage. | |
| Hybrid upsert | Accept optional ticketId, create if absent. Handles both Linear-triggered and Slack-triggered runs. | |
| Pipeline-created ticket | Pipeline always creates a new Linear issue at intake. Self-contained, works for Slack-first flow. | ✓ |

**User's choice:** Pipeline-created ticket, with refinement
**Notes:** User proposed parent ticket + phase sub-tickets hierarchy: intake creates parent ticket for the pipeline run, each phase creates a sub-ticket linked to the parent. Stage transitions update the active sub-ticket. PR URL links to parent on completion. This mirrors the harness's own pipeline run + phase structure.

---

## PostHog Instrumentation

| Option | Description | Selected |
|--------|-------------|----------|
| Shared analytics module | Full module with typed wrapper functions (trackAgentRun, trackPhaseTransition, etc.). | |
| PostHog SDK per Lambda | Each Lambda imports PostHog SDK directly. Simplest but risks event loss. | |
| CloudWatch logs + PostHog ingestion | No SDK dep, reuses logging. PostHog Logs beta. | |
| Dedicated analytics Lambda via SQS | Fire-and-forget to SQS, analytics Lambda batches sends. Overkill. | |
| Thin PostHog utility | Lightweight analytics.ts with client init, track(), flush(). (Refined from shared module) | ✓ |

**User's choice:** Thin PostHog utility
**Notes:** User pushed back on the shared analytics module as over-engineered. Proposed direct SDK calls from each Lambda. Refined to a thin utility file (~20-30 lines) wrapping client init, track(), and flush() for consistent event structure without heavyweight abstraction. Event name conventions documented, not enforced by typed functions.

---

## Claude's Discretion

- Slack Block Kit message layout, API Gateway config, approval token expiry
- Feature branch naming format, integration executor implementation details
- Linear field mapping, status name mapping, sub-ticket structure
- PostHog event property schemas, distinct_id strategy

## Deferred Ideas

- Linear webhook triggering pipeline runs (ticket-triggered flow)
- Hybrid Linear upsert (accept optional ticketId)
- Step Functions for approval gate
- Lambda Durable Functions (revisit when feature matures)

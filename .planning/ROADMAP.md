# Roadmap: Cloud Agent Harness

## Overview

This roadmap transforms the local GSD harness into a cloud-native autonomous feature delivery platform. The build order follows a strict dependency chain: AWS infrastructure and Daytona agent runtime must exist before orchestration can dispatch work; orchestration and checkpoint/resume must exist before integrations can hook into the pipeline; integrations (especially Slack approval) must exist before the headless auto-decision engine can safely escalate high-risk decisions to humans; and observability requires a running pipeline producing data to observe. Each phase delivers a verifiable, end-to-end capability on top of the previous one.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: AWS Foundation & Agent Runtime** - Provision AWS infrastructure via CDK and validate Daytona workspace lifecycle for agent execution (completed 2026-04-16)
- [ ] **Phase 2: Pipeline Orchestration & State Management** - Lambda+SQS pipeline with checkpoint/resume and storage abstraction for agent pull/push
- [ ] **Phase 3: Integrations** - Slack approval workflow, Git/PR delivery, Linear tracking, and PostHog event instrumentation
- [ ] **Phase 4: Headless Pipeline** - Replace interactive questioning with LLM auto-decisions and enable fully autonomous pipeline execution
- [ ] **Phase 5: Observability & CLI** - PostHog-based run tracking, CLI status queries, and Postgres-backed agent session telemetry

## Phase Details

### Phase 1: AWS Foundation & Agent Runtime
**Goal**: A single agent can execute a task end-to-end inside a Daytona workspace using cloud storage (S3 + Postgres) with no local filesystem dependencies
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05
**Success Criteria** (what must be TRUE):
  1. CDK deploy creates VPC, S3 bucket, RDS Postgres, Secrets Manager secrets, IAM roles, and SQS queue in a single command
  2. A Daytona workspace can be provisioned via API, execute an agent task against the Claude API, and be torn down programmatically
  3. Agent artifacts (.planning/ files, codebase maps) round-trip through S3 -- upload before task, download after task, contents verified identical
  4. Postgres accepts connections from Daytona workspace network, base schema (pipeline_runs, agent_runs) is queryable
  5. SQS queue accepts a pipeline job message, delivers it to a consumer, and dead-letters after max retries
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — CDK infrastructure stack with all AWS resources (VPC, S3, RDS, SQS, IAM, Secrets Manager) and assertion tests
- [x] 01-02-PLAN.md — Cloud service clients (Daytona, S3, Postgres, SQS) with shared types and unit tests
- [x] 01-03-PLAN.md — Database schema, vitest config update, and end-to-end validation script

### Phase 2: Pipeline Orchestration & State Management
**Goal**: A multi-step pipeline (research, plan, approve, execute, verify, PR) runs end-to-end via Lambda+SQS orchestration, checkpoints at each agent task boundary, and resumes from the last good checkpoint after failure
**Depends on**: Phase 1
**Requirements**: PIPE-01, PIPE-04, STATE-01, STATE-02, STATE-03, STATE-04
**Success Criteria** (what must be TRUE):
  1. Lambda+SQS pipeline executes the full pipeline lifecycle (intake -> research -> plan -> approve -> execute -> verify -> PR) with stage progression visible in Postgres
  2. Killing a pipeline mid-run and restarting it resumes from the last completed agent task checkpoint with no duplicate artifacts or side effects
  3. Agents pull codebase context from S3 at task start and push artifacts back to S3 after execution -- no local state persists between agent runs
  4. Every external write (git commit, Slack message, Linear update) uses an idempotency key derived from run_id:phase:plan:wave, verified by replaying a checkpoint
  5. Postgres checkpoint rows contain full pipeline state at agent task boundaries, queryable for any run
**Plans**: 5 plans

Plans:
- [x] 02-01-PLAN.md — Pipeline types, schema migration, and idempotency module (STATE-03)
- [x] 02-02-PLAN.md — S3 context sync and agent entrypoint script for Daytona sandboxes (PIPE-04, STATE-04)
- [x] 02-03-PLAN.md — Checkpoint, resume, sandbox-task wrapper, image builder, and snapshot manager (STATE-01, STATE-02)
- [x] 02-04-PLAN.md — Pipeline stage handlers (7 stages) and stage router (PIPE-01)
- [x] 02-05-PLAN.md — CDK Lambda construct and cah-stack wiring (PIPE-01)

### Phase 3: Integrations
**Goal**: The pipeline connects to external systems -- users approve plans in Slack, completed work lands as a GitHub PR, Linear tickets track status, and PostHog captures pipeline events
**Depends on**: Phase 2
**Requirements**: INTG-01, INTG-02, INTG-03, INTG-04
**Success Criteria** (what must be TRUE):
  1. A Slack message with Block Kit approve/reject buttons is sent when the pipeline reaches the approval gate, and clicking approve resumes the pipeline execution via SQS re-enqueue
  2. The pipeline creates a feature branch, makes atomic commits per task, and opens a PR with a structured description as its final output
  3. Linear ticket status updates at each pipeline phase transition, and the completed PR URL is linked back to the originating Linear ticket
  4. PostHog receives events for agent runs, token usage, cost accrual, pipeline status changes, and phase transitions -- viewable in the PostHog dashboard
**Plans**: 5 plans

Plans:
- [ ] 03-01-PLAN.md — Pipeline types extension, approvals migration, Postgres query functions, and PostHog analytics utility (INTG-01, INTG-04)
- [ ] 03-02-PLAN.md — Slack, GitHub, and Linear integration utility modules with SDK wrappers and tests (INTG-01, INTG-02, INTG-03)
- [ ] 03-03-PLAN.md — Stage handler modifications (approve, intake, PR, stage-router) and merge executor (INTG-01, INTG-02, INTG-03, INTG-04)
- [ ] 03-04-PLAN.md — Agent entrypoint git push and CDK Slack webhook construct (INTG-01, INTG-02)
- [ ] 03-05-PLAN.md — Slack webhook Lambda handler with signature verification and pipeline resume (INTG-01)

### Phase 4: Headless Pipeline
**Goal**: The pipeline runs fully autonomously after the initial questioning phase -- an LLM agent makes routine decisions that previously required human input, and high-risk decisions escalate to Slack
**Depends on**: Phase 3
**Requirements**: PIPE-02, PIPE-03
**Success Criteria** (what must be TRUE):
  1. A pipeline triggered from the CLI questioning phase runs through research, planning, approval, execution, and PR delivery with zero human interaction after Slack approval
  2. The LLM auto-decision agent handles routine decisions (naming, file placement, implementation approach) without pausing the pipeline, and logs each decision to a DECISIONS.md audit trail
  3. High-risk decisions (architecture changes, dependency additions, scope questions) escalate to Slack for human approval rather than being auto-decided
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Observability & CLI
**Goal**: Operators can monitor pipeline health, query run status from the CLI, and inspect per-agent telemetry for debugging and cost tracking
**Depends on**: Phase 4
**Requirements**: OBS-01, OBS-02, OBS-03
**Success Criteria** (what must be TRUE):
  1. PostHog displays current phase, cumulative cost, and completion status for any active or completed pipeline run
  2. A CLI command lists recent runs with status, and a second command shows detailed phase progress for a specific run
  3. Postgres stores per-agent session telemetry (tool calls, output references, token usage, duration, status) and this data is queryable for cost analysis and debugging
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. AWS Foundation & Agent Runtime | 3/3 | Complete    | 2026-04-16 |
| 2. Pipeline Orchestration & State Management | 0/5 | Not started | - |
| 3. Integrations | 0/5 | Not started | - |
| 4. Headless Pipeline | 0/2 | Not started | - |
| 5. Observability & CLI | 0/2 | Not started | - |

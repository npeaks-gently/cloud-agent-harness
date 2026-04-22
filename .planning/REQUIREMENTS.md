# Requirements: Cloud Agent Harness

**Defined:** 2026-04-15
**Core Value:** End-to-end autonomous feature delivery: user describes what they want, approves a plan in Slack, and gets a PR with the implementation.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Infrastructure

- [ ] **INFRA-01**: AWS foundation provisioned via CDK (VPC for RDS, S3 buckets, Secrets Manager, IAM roles)
- [ ] **INFRA-02**: RDS Postgres instance for runtime state, checkpoints, and agent session telemetry
- [ ] **INFRA-03**: S3 bucket for durable artifact storage (.planning/ files, codebase maps)
- [ ] **INFRA-04**: Daytona workspace provisioning for agent tasks via API (create, execute, teardown)
- [ ] **INFRA-05**: SQS queue for pipeline job intake with dead letter handling

### Pipeline

- [ ] **PIPE-01**: Step Functions state machine for end-to-end pipeline (research -> plan -> approve -> execute -> PR)
- [ ] **PIPE-02**: Headless pipeline execution with no human interaction after initial questioning phase
- [ ] **PIPE-03**: Interaction abstraction replacing AskUserQuestion with LLM agent for autonomous decisions
- [ ] **PIPE-04**: Codebase context provisioning via S3 so cloud agents can reference the monorepo map
- [ ] **PIPE-05**: Project-level research and roadmap synthesis stages that produce PROJECT.md + ROADMAP.md in the cloud from the `/gsd-new-project` seed, replacing per-phase research
- [ ] **PIPE-06**: Single project-level Slack approval gate with summary-card message and GitHub gist preview links, replacing per-phase plan approval (supersedes INTG-01 for the approval UX)
- [ ] **PIPE-07**: Stage-router-driven autonomous phase loop: after `verify`, the router reads ROADMAP.md from S3 and either re-enqueues `plan` for phase+1 or advances to `pr`
- [ ] **PIPE-08**: Per-run commit accumulation on featureBranch with hybrid workspace hydration (git for code, S3 for `.planning/`); all phases commit to the same branch so one PR contains every phase's work
- [ ] **PIPE-09**: Failure classification with transient auto-retry + permanent fail-fast + hard-abort after N permanent failures across a run

### State Management

- [ ] **STATE-01**: Postgres-backed checkpoint at wave and phase boundaries with full pipeline state
- [ ] **STATE-02**: Resume from last good checkpoint on any transient failure (API timeout, workspace crash)
- [ ] **STATE-03**: Idempotency keys on all external writes (git commits, Slack messages, Linear updates, PR creation)
- [ ] **STATE-04**: Storage abstraction where agents pull context from S3/Postgres at task start and push artifacts back after execution

### Integrations

- [ ] **INTG-01**: Slack approval workflow with Block Kit approve/reject buttons for plan approval
- [ ] **INTG-02**: Git integration and PR delivery (branch creation, atomic commits per task, PR with structured description)
- [ ] **INTG-03**: Linear integration with pipeline status updates on ticket and PR link-back on completion
- [ ] **INTG-04**: PostHog event tracking for agent runs, token usage, cost, pipeline status, and phase transitions

### Observability

- [ ] **OBS-01**: PostHog-based run status tracking (current phase, cost accrual, completion status)
- [ ] **OBS-02**: Pipeline status queryable via CLI (run list, run status, phase progress)
- [ ] **OBS-03**: Postgres-backed agent session telemetry (tool calls, output references, token usage, duration, status per agent execution)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Agent Feedback

- **FEED-01**: Agentic code review agent that reviews executor output before committing
- **FEED-02**: Verifier rejection loop (verifier rejects, triggers re-execution, max 3 cycles)
- **FEED-03**: Adaptive replanning on failure (classify failure type, replan/retry/escalate)

### Execution Optimization

- **EXEC-01**: Multi-model routing (Opus for planning/review, Sonnet/Haiku for execution)
- **EXEC-02**: Wave-based parallel execution in cloud (parallel Daytona workspaces per wave)
- **EXEC-03**: Token budget with hard ceiling and threshold alerts (50/80/100%)

### User Experience

- **UX-01**: Web dashboard for monitoring agent runs, costs, and pipeline status
- **UX-02**: Web-based interactive questioning phase (replace CLI)
- **UX-03**: Real-time streaming of agent output to dashboard

### Codebase Intelligence

- **INTEL-01**: Agent-maintained documentation and skills in monorepo
- **INTEL-02**: Multi-repo support for targeting different repositories

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Agent-to-agent direct messaging | File-based communication via artifacts is auditable, checkpointable, and proven in existing architecture |
| Dynamic/unbounded agent spawning | Fixed topology from plan prevents runaway costs and infinite loops |
| Plugin/extension system | Internal tool for small team; direct code modification is simpler |
| Conversation memory across runs | Fresh context per run is cleaner; all context is explicit via .planning/ and Postgres |
| ECS Fargate / EFS | Daytona handles compute; eliminates EFS consistency risks and container image management |
| Self-hosted observability (Jaeger, Grafana) | PostHog Cloud handles analytics and event tracking |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1: AWS Foundation & Agent Runtime | Pending |
| INFRA-02 | Phase 1: AWS Foundation & Agent Runtime | Pending |
| INFRA-03 | Phase 1: AWS Foundation & Agent Runtime | Pending |
| INFRA-04 | Phase 1: AWS Foundation & Agent Runtime | Pending |
| INFRA-05 | Phase 1: AWS Foundation & Agent Runtime | Pending |
| PIPE-01 | Phase 2: Pipeline Orchestration & State Management | Pending |
| PIPE-02 | Phase 4: Headless Pipeline | Pending |
| PIPE-03 | Phase 4: Headless Pipeline | Pending |
| PIPE-04 | Phase 2: Pipeline Orchestration & State Management | Pending |
| STATE-01 | Phase 2: Pipeline Orchestration & State Management | Pending |
| STATE-02 | Phase 2: Pipeline Orchestration & State Management | Pending |
| STATE-03 | Phase 2: Pipeline Orchestration & State Management | Pending |
| STATE-04 | Phase 2: Pipeline Orchestration & State Management | Pending |
| INTG-01 | Phase 3: Integrations | Pending |
| INTG-02 | Phase 3: Integrations | Pending |
| INTG-03 | Phase 3: Integrations | Pending |
| INTG-04 | Phase 3: Integrations | Pending |
| PIPE-05 | Phase 5: Pipeline Restructure | Pending |
| PIPE-06 | Phase 5: Pipeline Restructure | Pending |
| PIPE-07 | Phase 5: Pipeline Restructure | Pending |
| PIPE-08 | Phase 5: Pipeline Restructure | Pending |
| PIPE-09 | Phase 5: Pipeline Restructure | Pending |
| OBS-01 | Phase 6: Observability & CLI | Pending |
| OBS-02 | Phase 6: Observability & CLI | Pending |
| OBS-03 | Phase 6: Observability & CLI | Pending |

**Coverage:**
- v1 requirements: 25 total
- Mapped to phases: 25
- Unmapped: 0

---
*Requirements defined: 2026-04-15*
*Last updated: 2026-04-22 after Phase 5 scope change (pipeline restructure; Observability moved to Phase 6)*

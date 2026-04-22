# Phase 5: Pipeline Restructure - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Restructure the cloud pipeline so a project goes end-to-end from **one** `/gsd-new-project` run locally to **one** Slack approval at the project level to **one** PR containing every phase's commits — with no further human intervention between approval and PR.

This replaces the per-phase approval model that Phase 4 implicitly assumed. Phase 4's live e2e (run `1cb91052`) surfaced an architectural mismatch: the plan sandbox writes code, the execute sandbox sees an empty workspace (downloadPlanningDir only pulls `.planning/`), execute produces no diff, PR stage opens an empty PR. Phase 5 closes that gap and reshapes the pipeline around the autonomous-loop UX.

**In scope:**
- Hybrid workspace hydration (git for code, S3 for `.planning/`) so each sandbox sees prior stages' commits
- Execute stage owns git commit + push to featureBranch; merge-executor + per-stage taskBranches removed
- New project-level stages: `project-research`, `roadmap-synthesis`, `project-approve`
- Phase-loop driver in the stage-router: after `verify`, re-enqueue `plan` for phase+1 or advance to `pr`
- Single Slack approval message (summary card + GitHub gist preview) with Approve/Reject
- Transient auto-retry + permanent fail-fast escalation inside the autonomous loop
- Total-run failure budget (N permanent failures → hard-abort)

**Not in scope:**
- Observability & CLI (OBS-01/02/03) — moves to new Phase 6 (ROADMAP.md + REQUIREMENTS.md update needed)
- EXEC-02 parallel execute sandboxes — v2
- Request-changes button (cloud-side iteration loop) — user iterates locally via `/gsd-new-project` instead
- Hard USD/elapsed cost cap — replaced by permanent-failure budget

</domain>

<decisions>
## Implementation Decisions

### Workspace hydration + commit strategy

- **D-01:** Hybrid hydration. Every sandbox runs `git clone/fetch <featureBranch>` for the target repo **and** S3-downloads `runs/{runId}/planning/` into the workspace. After work: execute sandbox `git commit` + `git push` code; every stage S3-uploads modified `.planning/` back. `.planning/` **never** enters the target repo's PR — target repos stay clean.
- **D-02:** Only the execute sandbox commits code in v1. Research / plan / verify sandboxes produce `.planning/` artifacts only (stored in S3, not committed). Execute commits atomically and pushes directly to featureBranch — no taskBranches, no merge stage.
- **D-03:** Archive `src/cloud/pipeline/merge-executor.ts` for v1. EXEC-02 (parallel execute sandboxes) is v2; revisit the merge-executor vs push-with-rebase choice at that point, informed by v2 design context.

### Phase-loop driver

- **D-04:** The stage-router Lambda (`src/cloud/pipeline/stage-router.ts`) owns phase-loop control. Extend `NEXT_STAGE` from a static map to a function: when `msg.stage === Verify`, read `pipeline_runs.phase_current` + ROADMAP.md, decide `Plan(phase+1)` vs `PR`.
- **D-05:** DB tracks only `phase_current`. ROADMAP.md in S3 is the single source of truth for the phase list. Router reads ROADMAP.md from S3 on each phase-loop decision (same-region GET, ~50ms — negligible next to sandbox cold starts).
- **D-06:** Extend `PipelineStage` enum with `ProjectResearch`, `RoadmapSynthesis`, `ProjectApprove`. Keep `Plan` / `Execute` / `Verify` as per-phase stages, looped by the router. `PR` runs once at end. The existing `Research` stage is renamed to `ProjectResearch` (or deprecated) — it no longer maps to per-phase research. Per-phase research is handled inside the in-sandbox `gsd.runPhase` GSD flow, not as a cloud stage.

### Failure / escalation inside the autonomous loop

- **D-07:** Default escalation policy = **transient auto-retry, permanent fail-fast**. Transient failures (Anthropic/Daytona/GitHub rate limit, network, sandbox cold-start crash) auto-retry the stage with backoff. Permanent failures (verify rejection, GSD "can't proceed", auto-decider stuck, compile error GSD can't resolve, unrecoverable external API error) pause the run and DM the user in Slack with error summary + resume/abort buttons.
- **D-08:** Tighten the Phase 4 auto-decider escalation model. Routine risk categories (minor dep additions, file placement, naming) auto-decide with audit log. Only pipeline-stopping questions (scope shifts the roadmap didn't anticipate, architecture changes outside plan) escalate to Slack.
- **D-09:** On Slack-resumed failure, re-run only the failed stage. Idempotency/checkpoint infrastructure (STATE-03) already enforces stage-level idempotency so this is safe.
- **D-10:** Hard-abort budget = max **N** permanent failures across the whole run. Transient retries don't count against the budget. On hard-abort, send single Slack notification, mark run failed, close Linear ticket with reason. Suggested default N=3 — planner to finalize.

### Project-approve Slack message

- **D-11:** Content = summary card. Block Kit fields: project name, 1-line core value, phase count, phase list (titles), estimated token/cost range. Two primary buttons: Approve + Reject. Section with gist links for full PROJECT.md + ROADMAP.md.
- **D-12:** Buttons = Approve / Reject. Approve resumes the pipeline (matches Phase 3 webhook pattern). Reject kills the run.
- **D-13:** Preview = GitHub secret gist. The `roadmap-synthesis` handler (or `project-approve` handler) creates a secret gist containing PROJECT.md + ROADMAP.md via the existing `cah-dev-github-token` (needs `gist` scope added to the PAT). Slack links point at the gist URLs. GitHub renders markdown natively — no custom rendering infra. Gist cleanup is optional (out of scope for v1; add a retention Lambda later if needed).
- **D-14:** On reject → mark `pipeline_run` failed, close Linear parent ticket with rejection reason, no retry. User refines intent by re-running `/gsd-new-project` locally and re-dispatching via `cah-dispatch`. No cloud-side feedback loop.

### Claude's Discretion

- Exact retry count + backoff schedule for transient failures (starting suggestion: 3 attempts, exponential backoff capped at 60s)
- Default N for the permanent-failure budget (suggested 3)
- Exact Slack Block Kit layout / button colors / field ordering
- Gist title and description format
- Whether to emit per-stage status reactions on the Slack approval message as the autonomous loop progresses (nice-to-have observability; doesn't block)
- How `Research` stage is removed from the enum — rename vs deprecate vs delete
- Migration strategy for the existing `approval_type` column from Phase 4

### Folded Todos

None — no todos matched Phase 5 at init time (`todo match-phase 5` returned empty).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 4 artifacts (this phase evolves from Phase 4's output)
- `.planning/phases/04-headless-pipeline/04-CONTEXT.md` — Phase 4 headless-pipeline decisions; Phase 5 extends/supersedes several (per-phase approval → project approval; auto-decider scope tightened)
- `.planning/phases/04-headless-pipeline/04-BOUNDARY-VERIFICATION.md` — integration reality check that surfaced the empty-PR architectural mismatch
- `.planning/phases/04-headless-pipeline/04-VERIFICATION.md` — what completed vs. what didn't in Phase 4

### Ops artifacts
- `.planning/FIXES.md` — FIX-007..FIX-010 infra gaps closed en route (Lambda stub, NAT gateway, LINEAR_TEAM_ID, snapshot publish)

### Pipeline code to modify
- `src/cloud/pipeline/stage-router.ts` — phase-loop driver logic extends `NEXT_STAGE` + routeStage (D-04)
- `src/cloud/pipeline/types.ts` — `PipelineStage` enum additions + `StageMessage.context` schema for project-level data (D-06)
- `src/cloud/pipeline/checkpoint.ts` — `phase_current` tracking
- `src/cloud/pipeline/resume.ts` — verify compatibility with phase-loop semantics
- `src/cloud/pipeline/idempotency.ts` — ensure keys include `phase_current` for per-phase stages
- `src/cloud/pipeline/stages/approve.ts` — reframe from per-phase plan approval to project-level roadmap approval (or split into project-approve.ts; see D-11..D-14)
- `src/cloud/pipeline/stages/research.ts` — rename/deprecate; project-level research is a new handler
- `src/cloud/pipeline/stages/plan.ts` — becomes per-phase-plan, loses project-level responsibility
- `src/cloud/pipeline/stages/execute.ts` — adds git commit + push responsibility (D-02)
- `src/cloud/pipeline/stages/verify.ts` — unchanged behavior but now per-phase
- `src/cloud/pipeline/stages/pr.ts` — runs once at end; remove per-phase PR logic
- `src/cloud/pipeline/merge-executor.ts` — archive (D-03)
- `src/cloud/pipeline/sandbox-task.ts` — already wires `CAH_GITHUB_TOKEN` + `CAH_FEATURE_BRANCH`; may need per-phase env additions

### New code to create
- `src/cloud/pipeline/stages/project-research.ts` — new handler for parallel project-level researchers + synthesizer
- `src/cloud/pipeline/stages/roadmap-synthesis.ts` — new handler that produces/refines PROJECT.md + ROADMAP.md, creates the gist
- `src/cloud/pipeline/stages/project-approve.ts` — new handler for the single Slack approval gate (or repurposed approve.ts)

### Sandbox entrypoint changes
- `src/cloud/entrypoint/agent-entrypoint.ts` — adds `git clone/fetch` target repo + S3 sync `.planning/` at startup; adds `git commit` + `git push` at end for execute stage (D-01, D-02)
- `scripts/build-daytona-snapshot.ts` — update if entrypoint/snapshot contents change

### Slack / integration code
- `src/cloud/integrations/slack.ts` — new message builder for the project-approve summary card (D-11)
- `src/cloud/integrations/github.ts` — add gist creation helper (D-13)
- `src/cloud/integrations/linear.ts` — update ticket lifecycle for reject path (D-14)
- Slack webhook Lambda (wherever the reject button lands) — reject handler path

### Non-code artifacts that need updating
- `.planning/ROADMAP.md` — Phase 5 scope change + append Phase 6 "Observability & CLI"
- `.planning/REQUIREMENTS.md` — re-map OBS-01/02/03 to Phase 6; potentially add new PIPE-05/06/07 for project-level stages
- `.planning/PROJECT.md` — update Key Decisions table with 2026-04-22 pipeline restructure decision

### Locked-design memory (session context, not readable by downstream agents — mirrored below for reference)
- `project_phase5_design.md` (locked 2026-04-22) — handoff point, single approval, autonomy, one PR
- `project_pipeline_gaps_2026-04-22.md` — the architectural mismatch and commit-accumulation root cause
- `project_smoke_test_state.md` — infra state at session start (NAT up, snapshot `cah-harness-v1` live)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`stage-router.ts`** — SQS dispatch + `NEXT_STAGE` + `STAGE_HANDLERS` map; extend for the phase loop rather than rewrite
- **`checkpoint.ts`** — per-stage idempotency-aware updates to `pipeline_runs`
- **`idempotency.ts`** — idempotency key derivation; reuse for per-phase stages
- **`resume.ts`** — resume-from-checkpoint logic; verify compatibility with phase loop
- **`sandbox-task.ts`** — wires `CAH_GITHUB_TOKEN` + `CAH_FEATURE_BRANCH` into the sandbox (landed in this session per pipeline-gaps memo)
- **`agent-entrypoint.ts`** — `.planning/` S3 download/upload wiring; token tracking aggregation (landed in this session)
- **`integrations/linear.ts`** — parent ticket + sub-ticket lifecycle helpers
- **`integrations/github.ts`** — PR creation; extend with gist creation
- **`integrations/slack.ts`** — Block Kit message builders + button-click webhooks; extend for project-approve card
- **Daytona snapshot `cah-harness-v1`** — structurally sound, GSD runs end-to-end inside it (proven in this session)
- **PostHog analytics (`analytics.ts`)** — `stage_completed` events, token usage aggregation

### Established Patterns
- **SQS message per stage, serial execution** — one Daytona sandbox per SQS message
- **Checkpoint at every stage boundary** — `pipeline_runs.current_stage` advances atomically
- **S3 path convention** — `runs/{runId}/planning/` for `.planning/` artifacts
- **Secrets lazy-loaded at Lambda cold start** — see `getPool`, `getDaytonaClient` in stage-router.ts
- **Type-guarded SQS routing** — `isStageMessage` vs `isPipelineJobMessage`
- **Slack message → webhook → SQS re-enqueue** — proven pattern from Phase 3 per-phase approval (reused for project-approve)
- **Fine-grained PAT in Secrets Manager** — `cah-dev-github-token`; add `gist` scope

### Integration Points
- **`scripts/cah-dispatch`** — local CLI uploads `.planning/` + sends SQS message; entry point for the pipeline. Bootstrap contract: `/gsd-new-project` output must include PROJECT.md seed, partial ROADMAP, discovery answers.
- **Slack webhook Lambda** — where approve/reject button clicks land; needs a new branch for project-approve reject (D-14)
- **Postgres migrations** — migrations live in `scripts/migrate-*.sql`; new migration needed for any schema changes (e.g., removing `approval_type`, confirming `phase_current` default, failure budget column)

</code_context>

<specifics>
## Specific Ideas

Core design is locked in memory `project_phase5_design.md`; this CONTEXT operationalizes it. No additional product-reference specifics beyond the locked design.

</specifics>

<deferred>
## Deferred Ideas

- **OBS-01 / OBS-02 / OBS-03 (Observability & CLI)** — moves to new Phase 6. ROADMAP.md + REQUIREMENTS.md need updating to reflect this re-mapping. Token tracking + PostHog agent_run events partially cover OBS-01 already.
- **EXEC-02 (parallel execute sandboxes)** — v2. When it ships, revisit merge-executor vs push-with-rebase design; Phase 5 archiving merge-executor is deliberate so v2 can choose cleanly.
- **Hard USD / elapsed cost cap** — presented as an option, not chosen. Permanent-failure count is the sole runaway-guard in v1. Can revisit in v2 if production runs drift in cost/duration.
- **Request-changes button / cloud-side feedback loop** — rejected. User iterates locally via `/gsd-new-project` + re-dispatch.
- **Committing `.planning/` to featureBranch for audit trail** — rejected in Area 1. S3 is the sole runtime source of truth.
- **Gist retention/cleanup Lambda** — out of scope for v1. Secret gists are small; accumulate harmlessly until a future cleanup pass.
- **Render `.planning/` to S3 static site for approval preview** — rejected in favor of GitHub gist.

### Reviewed Todos (not folded)
None — todo match returned empty.

</deferred>

---

*Phase: 05-pipeline-restructure*
*Context gathered: 2026-04-22*

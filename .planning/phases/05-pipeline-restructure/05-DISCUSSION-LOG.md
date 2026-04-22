# Phase 5: Pipeline Restructure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered and the user's rationale for picking between them.

**Date:** 2026-04-22
**Phase:** 5-pipeline-restructure
**Areas discussed:** Workspace hydration + commit strategy; Phase-loop driver location; Failure/escalation inside the autonomous loop; Project-approve Slack message content

---

## Meta Decision — Phase 5 scope

Before gray-area discussion could begin, a scope conflict was surfaced and resolved.

| Option | Description | Selected |
|--------|-------------|----------|
| Pipeline restructure | Per locked 2026-04-22 design: one Slack approval, autonomous phase loop, one PR. | ✓ |
| Observability & CLI (original) | OBS-01/02/03 per ROADMAP.md as originally written. | |
| Bundle both | Pipeline restructure + observability in the same phase. | |

**User's choice:** Pipeline restructure.
**Notes:** The locked design memory and recent commits on branch `04-22-sf-v0-p5` both target the pipeline restructure. The roadmap as written is stale and will be updated.

### Obs destination

| Option | Description | Selected |
|--------|-------------|----------|
| New Phase 6 | Append a new Phase 6: Observability & CLI to the roadmap. | ✓ |
| Defer to v2 | Move OBS-01/02/03 to v2. | |
| Partial close + defer | Close OBS-01 partially (token tracking done); defer OBS-02/03. | |

**User's choice:** New Phase 6.

---

## Area 1 — Workspace hydration + commit strategy

### Q1 (initial framing, retracted)

Initial recommendation was "git fetch featureBranch for everything (code + .planning/)". User pushed back correctly: `.planning/` isn't in the target repo; pure git model would leave sandboxes with no GSD state.

### Q1 (reframed) — Where does `.planning/` come from?

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: git for code, S3 for `.planning/` | Each sandbox git-fetches featureBranch + S3-downloads `.planning/`. Target repos stay clean. | ✓ |
| Commit `.planning/` to featureBranch | Pure git, but PR contains `.planning/`. | |
| Both: S3 + mirror to featureBranch | Belt-and-suspenders; more writes per phase. | |

**User's choice:** Hybrid.
**Notes:** `.planning/` never enters the PR — target repos that didn't adopt GSD aren't polluted.

### Q2 — Who commits code in v1?

| Option | Description | Selected |
|--------|-------------|----------|
| Execute sandbox commits+pushes to featureBranch | No taskBranches, no merge-executor. | ✓ |
| Phase-commit Lambda stage | Sandbox uploads workspace; Lambda commits. | |
| Keep per-stage task branches + merge executor | Existing model, preserves investment but perpetuates gap. | |

**User's choice:** Execute sandbox.
**Notes:** v1 is serial (EXEC-02 is v2); only execute produces code diffs, so "one commit per phase" is the natural flow.

### Q3 — What happens to `merge-executor.ts`?

| Option | Description | Selected |
|--------|-------------|----------|
| Archive — delete or move to legacy/ | Not earning its keep in v1. | ✓ |
| Keep unused in tree | Preserves option, risks confusion. | |
| Keep AND wire it in v1 serial path | Pointless overhead for v1. | |

**User's choice:** Archive.
**Notes:** User's follow-up discussion confirmed merge-executor was worktree-parallel-style design; v1's serial flow has no peers to merge.

---

## Area 2 — Phase-loop driver location

### Q1 — Where does "more phases or PR?" run?

| Option | Description | Selected |
|--------|-------------|----------|
| Stage-router Lambda | Extend routeStage() + NEXT_STAGE. Centralizes logic. | ✓ |
| Dedicated phase-complete Lambda stage | Explicit stage, adds SQS hop. | |
| Verify sandbox self-enqueues | Bad separation of concerns. | |

**User's choice:** Stage-router Lambda.

### Q2 (initial framing, retracted)

Initial recommendation was "roadmap-synthesis writes total_phases to DB + router reads ROADMAP for details." User pushed back: rationale was weak. Reconsidered — redundant source of truth; DB field can drift from ROADMAP.md.

### Q2 (reframed) — How is the phase list tracked?

| Option | Description | Selected |
|--------|-------------|----------|
| Router reads ROADMAP.md from S3 each hop | DB stores only phase_current. S3 is single source of truth. | ✓ |
| DB snapshot of total_phases | Redundant with S3; can drift. | |
| Pre-populate at intake | Not viable — ROADMAP is synthesized by the cloud. | |

**User's choice:** S3 single source of truth.

### Q3 — PipelineStage enum shape?

| Option | Description | Selected |
|--------|-------------|----------|
| Add project-* stages, keep plan/execute/verify per-phase | Clean separation between one-shot and looped. | ✓ |
| Keep flat enum, overload via phase_current | Handler-internal branching; hard to read. | |
| Two-level ProjectStage/PhaseStage structure | Cleanest mental model, biggest churn. | |

**User's choice:** Add project-* stages.

---

## Area 3 — Failure / escalation inside the autonomous loop

### Q1 — Default escalation policy?

| Option | Description | Selected |
|--------|-------------|----------|
| Transient auto-retry, permanent fail-fast | Classify failure type; retry infra, escalate real blockers. | ✓ |
| Fail-fast on any error | Simpler, friction on transient infra flakes. | |
| Non-stop, log + continue | Contradicts "worthwhile results". | |

**User's choice:** Transient auto-retry, permanent fail-fast.

### Q2 — Auto-decider escalation from Phase 4?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep escalation channel, same policy | As-is from Phase 4. | |
| Tighten: only pipeline-stopping questions escalate | Routine risks auto-decide with audit log. | ✓ |
| Remove escalation entirely | Strictest reading of "don't re-add gates". | |

**User's choice:** Tighten.

### Q3 — Resume point after Slack-resolved failure?

| Option | Description | Selected |
|--------|-------------|----------|
| Re-run the failed stage only | Fastest; relies on existing idempotency. | ✓ |
| Re-run the whole phase from plan | Safer for upstream causes, costlier. | |
| User picks stage-vs-phase in Slack | Two resume paths to support. | |

**User's choice:** Re-run failed stage only.

### Q4 — Total-run budget?

| Option | Description | Selected |
|--------|-------------|----------|
| Max N permanent failures total, then hard-abort | Transient retries don't count. | ✓ |
| Hard USD + elapsed cap | Cost protection, orthogonal to failure count. | |
| No limits | Fully autonomous; overnight runaway risk. | |

**User's choice:** Max N permanent failures (N TBD by planner, suggest 3).

---

## Area 4 — Project-approve Slack message

### Q1 — Content style?

| Option | Description | Selected |
|--------|-------------|----------|
| Summary card + preview links | Block Kit fields + buttons to full docs. | ✓ |
| Full PROJECT.md + ROADMAP.md inline | Hits Block Kit size limits. | |
| Minimal summary only | Unsafe for non-trivial runs. | |

**User's choice:** Summary card + preview links.

### Q2 — Button set?

| Option | Description | Selected |
|--------|-------------|----------|
| Approve / Reject | Matches Phase 3 pattern. | ✓ |
| Approve / Request changes / Reject | Cloud-side feedback loop; more code. | |
| Approve / Abort | Cosmetic relabel. | |

**User's choice:** Approve / Reject.

### Q3 (initial framing, retracted)

Initial recommendation was "S3 presigned URLs rendered in browser". User pushed back: rationale was weak. Reconsidered — S3 doesn't render markdown natively; presigned URLs serve raw text. Would need Lambda@Edge or an S3-hosted markdown renderer.

### Q3 (reframed) — Preview mechanism?

| Option | Description | Selected |
|--------|-------------|----------|
| GitHub gist via Lambda | Synthesis handler creates secret gist; GitHub renders markdown natively. | ✓ |
| S3 presigned URL + rendering infra | Extra Lambda@Edge or static site. | |
| Push to review-only branch | Extra branch per run; cleanup overhead. | |

**User's choice:** GitHub gist.
**Notes:** Requires adding `gist` scope to the existing `cah-dev-github-token` PAT. Cleanup optional for v1.

### Q4 — Rejection flow?

| Option | Description | Selected |
|--------|-------------|----------|
| Kill run, user iterates locally + re-dispatches | Matches "iterate on context locally" principle. | ✓ |
| Loop back to roadmap-synthesis with feedback modal | More responsive; ~2x code. | |

**User's choice:** Kill run, re-dispatch locally.

---

## Claude's Discretion

- Retry count + backoff schedule for transient failures
- Default N for the permanent-failure budget
- Slack Block Kit layout details
- Gist title/description format
- How the existing `Research` stage is removed (rename vs deprecate vs delete)
- Migration strategy for the existing `approval_type` column

## Deferred Ideas

- OBS-01/02/03 → new Phase 6
- EXEC-02 → v2
- Hard USD / elapsed cost cap → v2
- Request-changes button → out of scope
- `.planning/` to featureBranch → rejected
- Gist retention/cleanup Lambda → out of scope for v1

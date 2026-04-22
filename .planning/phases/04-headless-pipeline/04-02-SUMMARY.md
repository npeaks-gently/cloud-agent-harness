---
phase: 04-headless-pipeline
plan: 02
subsystem: auto-decider, slack-escalation, phase-runner, webhook
tags: [auto-decider, risk-escalation, slack-buttons, phase-lifecycle, approval-type]

# Dependency graph
requires:
  - phase: 04-headless-pipeline
    plan: 01
    provides: "PhaseStepType.AutoDecide enum, approval_type column, insertApproval approvalType param"
provides:
  - "auto-decider agent definition (agents/auto-decider.md) with decision classification rubric"
  - "sendEscalationMessage function in slack.ts with escalation_approve/reject action_ids"
  - "runAutoDecideStep in PhaseRunner between plan-check and execute (non-fatal)"
  - "Webhook handler extended for escalation_approve/escalation_reject actions"
  - "getApprovalByToken returns approvalType for stage resume logic"
  - "Escalation resume returns to current stage; plan approval advances to next stage"
affects: [04-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [non-fatal-step, action-id-routing, approval-type-discrimination]

key-files:
  created:
    - agents/auto-decider.md
    - src/cloud/test/escalation.test.ts
    - src/cloud/test/auto-decider.test.ts
  modified:
    - src/cloud/integrations/slack.ts
    - src/cloud/pipeline/stages/approve.ts
    - src/cloud/webhook/slack-handler.ts
    - src/cloud/postgres-client.ts
    - sdk/src/phase-runner.ts
    - sdk/src/types.ts
    - sdk/src/tool-scoping.ts
    - sdk/src/context-engine.ts
    - sdk/src/phase-prompt.ts
    - sdk/src/phase-runner.test.ts
    - sdk/src/phase-runner-types.test.ts
    - src/cloud/test/approve.test.ts

key-decisions:
  - "PhaseType.AutoDecide added to enum so loadAgentDef/buildPrompt/tool-scoping work natively"
  - "Auto-decide step is non-fatal: failure logs warning and pipeline continues to execute"
  - "makeConfig test helper defaults auto_decide to false so existing tests are unaffected"
  - "Escalation resume uses pipelineRun.config.currentStage to return to the executing stage"
  - "getApprovalByToken returns approvalType to enable webhook stage-resume discrimination"

patterns-established:
  - "Non-fatal lifecycle step pattern: guard with !== false, catch errors, warn, continue"
  - "Action ID routing: KNOWN_ACTIONS array for extensible Slack action handling"
  - "Approval type discrimination: different resume behavior based on approval_type column"

requirements-completed: [PIPE-03]

# Metrics
duration: 12min
completed: 2026-04-17
---

# Phase 4 Plan 2: Auto-Decider Agent, Risk Escalation, and PhaseRunner Integration Summary

**Auto-decider agent with decision classification rubric, sendEscalationMessage with Block Kit escalation buttons, runAutoDecideStep wired between plan-check and execute as non-fatal step, webhook handler extended for escalation actions with approval-type-based stage resume**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-17T13:39:02Z
- **Completed:** 2026-04-17T13:51:21Z
- **Tasks:** 2
- **Files created:** 3
- **Files modified:** 12

## Accomplishments

- Created auto-decider agent definition (agents/auto-decider.md) with YAML frontmatter, decision classification rubric (routine vs high-risk), DECISIONS.md output format, and escalation JSON stdout format
- Added sendEscalationMessage to slack.ts following the sendApprovalMessage pattern with escalation_approve/escalation_reject action_ids and Block Kit header/section/actions blocks
- Updated approve stage to pass explicit 'plan_approval' to insertApproval (self-documenting)
- Added PhaseType.AutoDecide enum value with corresponding PHASE_AGENT_MAP, PHASE_DEFAULT_TOOLS, PHASE_WORKFLOW_MAP, and PHASE_FILE_MANIFEST entries
- Added runAutoDecideStep private method to PhaseRunner following the runPlanCheckStep pattern with event emission, error handling, and planResult aggregation
- Wired auto-decide step into PhaseRunner.run() as Step 3.7 between plan-check and execute, guarded by config.workflow.auto_decide !== false (non-fatal on failure)
- Extended webhook handler KNOWN_ACTIONS to include escalation_approve and escalation_reject
- Updated isApproval check to handle both pipeline_approve and escalation_approve
- Added approvalType field to getApprovalByToken return type and SQL query
- Implemented approval-type-based stage resume: risk_escalation returns to current stage, plan_approval advances to next stage
- Created escalation.test.ts with 4 test cases covering Block Kit structure, risk reason, timestamp return, and error handling
- Created auto-decider.test.ts with 5 test cases covering PhaseStepType enum, agent definition loading, frontmatter validation, DECISIONS.md format, and escalation JSON format
- All 205 cloud-unit tests and 1086 SDK unit tests pass with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create auto-decider agent definition and sendEscalationMessage** - `11e245e` (feat)
2. **Task 2: Add runAutoDecideStep to PhaseRunner and extend webhook handler** - `d4bfd5b` (feat)

## Files Created/Modified

- `agents/auto-decider.md` - New agent definition with decision classification rubric and DECISIONS.md output format
- `src/cloud/integrations/slack.ts` - Added sendEscalationMessage with escalation action_ids
- `src/cloud/pipeline/stages/approve.ts` - Pass explicit 'plan_approval' to insertApproval
- `src/cloud/webhook/slack-handler.ts` - Extended KNOWN_ACTIONS, updated isApproval, added approval-type stage resume logic
- `src/cloud/postgres-client.ts` - Added approvalType to getApprovalByToken return
- `sdk/src/phase-runner.ts` - Added runAutoDecideStep method and Step 3.7 wiring
- `sdk/src/types.ts` - Added PhaseType.AutoDecide enum value
- `sdk/src/tool-scoping.ts` - Added AutoDecide entries to PHASE_DEFAULT_TOOLS and PHASE_AGENT_MAP
- `sdk/src/context-engine.ts` - Added AutoDecide entry to PHASE_FILE_MANIFEST
- `sdk/src/phase-prompt.ts` - Added AutoDecide entry to PHASE_WORKFLOW_MAP
- `sdk/src/phase-runner.test.ts` - Updated step order test, added auto_decide:false default, fixed step count tests
- `sdk/src/phase-runner-types.test.ts` - Updated PhaseStepType member count from 7 to 8
- `src/cloud/test/approve.test.ts` - Updated insertApproval assertion for explicit 'plan_approval' arg
- `src/cloud/test/escalation.test.ts` - New test file with 4 sendEscalationMessage tests
- `src/cloud/test/auto-decider.test.ts` - New test file with 5 auto-decider validation tests

## Decisions Made

- **PhaseType.AutoDecide added to enum:** loadAgentDef, buildPrompt, getToolsForPhase, and resolveContextFiles all accept PhaseType. Adding AutoDecide to the enum allows the auto-decide step to use the same infrastructure as other steps without type casts.
- **Non-fatal auto-decide step:** Auto-decide failure logs a warning and continues to execute. This aligns with the "default-routine bias" design -- if the agent fails, decisions will be made by the executor or interactively.
- **Test helper defaults auto_decide to false:** Rather than updating 50+ test configs, the makeConfig helper in phase-runner.test.ts defaults auto_decide to false. Tests that exercise auto-decide explicitly opt in.
- **Escalation resume via config.currentStage:** For risk_escalation approvals, the webhook reads pipelineRun.config.currentStage to determine which stage to resume at, rather than advancing via NEXT_STAGE.
- **getApprovalByToken returns approvalType:** The SQL query now includes approval_type so the webhook handler can discriminate between plan_approval and risk_escalation at resume time.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated approve.test.ts for explicit approval_type argument**
- **Found during:** Task 1
- **Issue:** Adding explicit 'plan_approval' to insertApproval call broke the existing test assertion that expected 5 args
- **Fix:** Updated test expectation to include 'plan_approval' as 6th argument
- **Files modified:** src/cloud/test/approve.test.ts
- **Commit:** 11e245e

**2. [Rule 1 - Bug] Fixed PhaseStepType member count test**
- **Found during:** Task 2
- **Issue:** Plan 01 added AutoDecide to PhaseStepType but test still expected 7 members (pre-existing)
- **Fix:** Updated count from 7 to 8
- **Files modified:** sdk/src/phase-runner-types.test.ts
- **Commit:** d4bfd5b

**3. [Rule 1 - Bug] Fixed phase-runner step order and cost aggregation tests**
- **Found during:** Task 2
- **Issue:** Adding auto-decide step caused it to run in tests that expected only plan/execute/advance
- **Fix:** Updated makeConfig to default auto_decide to false; updated full lifecycle test to explicitly enable it
- **Files modified:** sdk/src/phase-runner.test.ts
- **Commit:** d4bfd5b

**4. [Rule 2 - Missing functionality] Added PhaseType.AutoDecide to enum and all Record maps**
- **Found during:** Task 2
- **Issue:** Plan specified casting PhaseType but loadAgentDef/buildPrompt accept PhaseType enum, not strings. Record<PhaseType, ...> maps would fail TypeScript strict checks.
- **Fix:** Added AutoDecide to PhaseType enum and all corresponding maps (PHASE_AGENT_MAP, PHASE_DEFAULT_TOOLS, PHASE_WORKFLOW_MAP, PHASE_FILE_MANIFEST)
- **Files modified:** sdk/src/types.ts, sdk/src/tool-scoping.ts, sdk/src/phase-prompt.ts, sdk/src/context-engine.ts
- **Commit:** d4bfd5b

## Threat Surface Scan

No new threat surfaces beyond those documented in the plan's threat model. The escalation buttons reuse the existing HMAC-SHA256 signature verification and 5-minute replay window (T-04-04). The approval token double-resolution guard via `WHERE status = 'pending'` covers both approval types (T-04-05). The auto-decider agent prompt explicitly classifies auth/crypto/secrets/dependency decisions as high-risk requiring escalation (T-04-06).

## Known Stubs

None. All functions are fully implemented with real logic; no placeholder values or TODO markers.

## Next Phase Readiness

- Auto-decider agent definition ready for PhaseRunner to spawn during auto-decide step
- sendEscalationMessage ready for use by the auto-decide step when high-risk decisions detected
- Webhook handler ready to process both pipeline and escalation approval/rejection actions
- Plan 03 can use the planningPrefix + auto-decide infrastructure for CLI dispatch integration

## Self-Check: PASSED

All 12 created/modified files verified on disk. Both task commits (11e245e, d4bfd5b) verified in git log. TypeScript compiles clean. All 205 cloud-unit tests and 1086 SDK unit tests pass.

---
*Phase: 04-headless-pipeline*
*Completed: 2026-04-17*

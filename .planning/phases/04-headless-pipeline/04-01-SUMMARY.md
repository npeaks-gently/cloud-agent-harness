---
phase: 04-headless-pipeline
plan: 01
subsystem: types, database, pipeline
tags: [planningPrefix, auto-decide, approval-type, type-contracts, migration]

# Dependency graph
requires:
  - phase: 03-integrations
    provides: "Pipeline types (StageMessage, PipelineJobMessage), Postgres insertApproval, stage-router conversion, approvals table"
provides:
  - "PipelineJobMessage.planningPrefix field for S3 planning artifact prefix (D-13)"
  - "StageMessage.context.planningPrefix field for stage-to-stage forwarding (D-13)"
  - "PhaseStepType.AutoDecide enum value for auto-decide lifecycle step (D-03)"
  - "approval_type column on approvals table for discriminating plan vs risk approvals (D-06)"
  - "insertApproval approvalType parameter for typed approval insertion"
  - "planningPrefix forwarding through jobMessageToIntakeStageMessage"
affects: [04-02, 04-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [optional-field-forwarding, sql-alter-with-default, enum-extension]

key-files:
  created:
    - scripts/migrate-004-approval-type.sql
  modified:
    - src/cloud/types.ts
    - src/cloud/pipeline/types.ts
    - sdk/src/types.ts
    - src/cloud/postgres-client.ts
    - src/cloud/pipeline/stage-router.ts
    - src/cloud/test/stage-router.test.ts

key-decisions:
  - "planningPrefix is optional on both PipelineJobMessage and StageMessage.context to maintain backward compatibility"
  - "approval_type uses TEXT NOT NULL DEFAULT 'plan_approval' for backward-compatible schema extension (Pitfall 5)"
  - "AutoDecide enum placed between PlanCheck and Execute to reflect lifecycle ordering"

patterns-established:
  - "Optional field forwarding: job.planningPrefix -> context.planningPrefix in conversion functions"
  - "Schema extension via ALTER TABLE ADD COLUMN IF NOT EXISTS with DEFAULT for safe migration"

requirements-completed: [PIPE-02, PIPE-03]

# Metrics
duration: 2min
completed: 2026-04-17
---

# Phase 4 Plan 1: Shared Type Contracts and Schema Extensions Summary

**Extended PipelineJobMessage/StageMessage with planningPrefix (D-13), added PhaseStepType.AutoDecide (D-03), created migration 004 for approval_type discriminator, and updated stage-router to forward planningPrefix with 2 new tests**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-17T13:33:35Z
- **Completed:** 2026-04-17T13:35:52Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Extended PipelineJobMessage with optional planningPrefix field for S3 planning artifact key prefix (D-13)
- Extended StageMessage.context with optional planningPrefix field for inter-stage forwarding (D-13)
- Added AutoDecide value to PhaseStepType enum between PlanCheck and Execute (D-03)
- Created migration 004 adding approval_type TEXT column with DEFAULT 'plan_approval' and index (D-06, Pitfall 5)
- Extended insertApproval function to accept optional approvalType parameter (default: 'plan_approval')
- Updated jobMessageToIntakeStageMessage to forward planningPrefix from job to context (Pitfall 2 prevention)
- Added 2 new tests verifying planningPrefix forwarding (present and absent cases)
- All 196 cloud-unit tests pass with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend type contracts and migration** - `ac19f24` (feat)
2. **Task 2: Update stage-router conversion and add tests** - `3f69bcd` (feat)

## Files Created/Modified
- `src/cloud/types.ts` - Added planningPrefix field to PipelineJobMessage interface
- `src/cloud/pipeline/types.ts` - Added planningPrefix field to StageMessage.context
- `sdk/src/types.ts` - Added AutoDecide = 'auto_decide' to PhaseStepType enum
- `scripts/migrate-004-approval-type.sql` - New migration adding approval_type column with DEFAULT and index
- `src/cloud/postgres-client.ts` - Extended insertApproval with optional approvalType parameter, updated SQL to include approval_type column
- `src/cloud/pipeline/stage-router.ts` - Updated jobMessageToIntakeStageMessage to forward planningPrefix from job to context
- `src/cloud/test/stage-router.test.ts` - Added 2 tests for planningPrefix forwarding (present and absent)

## Decisions Made
- planningPrefix is optional on both PipelineJobMessage and StageMessage.context to maintain full backward compatibility with existing callers
- approval_type column uses TEXT NOT NULL DEFAULT 'plan_approval' rather than an enum to allow future type additions without migration (Pitfall 5)
- AutoDecide placed between PlanCheck and Execute in PhaseStepType to reflect the pipeline lifecycle ordering: plan -> plan_check -> auto_decide -> execute

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Threat Surface Scan

No new threat surfaces introduced beyond those already documented in the plan's threat model. The planningPrefix field accepts arbitrary strings but validation is deferred to the intake handler (T-04-01, covered in Plan 03). The approval_type column defaults to 'plan_approval' and the insertApproval function accepts any string value -- Plan 02 will constrain allowed values at the application layer (T-04-02).

## Next Phase Readiness
- planningPrefix type contracts ready for Plan 03 (CLI dispatch) to populate and Plan 02/03 intake handler to consume
- AutoDecide enum value ready for Plan 02 (auto-decider) to reference in step type routing
- approval_type migration and insertApproval extension ready for Plan 02 (risk escalation) to create risk_escalation approvals
- All existing tests continue to pass -- no regressions for Plans 02 and 03 to worry about

## Self-Check: PASSED

All 7 created/modified files verified on disk. Both task commits (ac19f24, 3f69bcd) verified in git log.

---
*Phase: 04-headless-pipeline*
*Completed: 2026-04-17*

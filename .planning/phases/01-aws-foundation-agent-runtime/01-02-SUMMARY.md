---
phase: 01-aws-foundation-agent-runtime
plan: 02
subsystem: infra
tags: [daytona, aws-sdk, s3, postgres, sqs, typescript, vitest]

# Dependency graph
requires:
  - phase: none (first implementation plan)
    provides: n/a
provides:
  - "Shared cloud types: PipelineRun, AgentRun, AgentTaskConfig, PipelineJobMessage, ArtifactKey"
  - "DaytonaClient: sandbox lifecycle wrapper (create/clone/execute/delete)"
  - "S3 artifact functions: upload/download/list with SHA256 checksums"
  - "Postgres client: connection pool with SSL, typed CRUD for pipeline_runs and agent_runs"
  - "SQS consumer: message receive/delete with PipelineJobMessage type guard"
affects: [01-03-e2e-validation, cloud-orchestrator, agent-runtime]

# Tech tracking
tech-stack:
  added: ["@daytonaio/sdk", "@aws-sdk/client-s3", "@aws-sdk/client-sqs", "@aws-sdk/client-secrets-manager", "@aws-sdk/lib-storage", "pg", "@types/pg"]
  patterns: ["class-based service clients with custom error classes", "pure async functions for stateless operations", "type guards for message validation", "parameterized SQL queries", "SSL-enforced database connections"]

key-files:
  created:
    - "src/cloud/types.ts"
    - "src/cloud/daytona-client.ts"
    - "src/cloud/s3-artifacts.ts"
    - "src/cloud/postgres-client.ts"
    - "src/cloud/sqs-consumer.ts"
    - "src/cloud/test/daytona-client.test.ts"
    - "src/cloud/test/s3-artifacts.test.ts"
    - "src/cloud/test/postgres-client.test.ts"
    - "src/cloud/test/sqs-consumer.test.ts"
  modified:
    - "package.json"
    - "package-lock.json"
    - "vitest.config.ts"

key-decisions:
  - "Used class-based mock pattern (vi.mock with class syntax) instead of vi.fn().mockImplementation() to avoid 'not a constructor' errors in Vitest"
  - "Renamed DaytonaError to DaytonaClientError to avoid naming collision with @daytonaio/sdk's built-in DaytonaError class"
  - "S3 and list functions accept optional client parameter for testability instead of always constructing new client internally"
  - "Postgres mapRowToPipelineRun and mapRowToAgentRun exported for direct unit testing of mapping logic"

patterns-established:
  - "cloud-service-client: Class with constructor options object, private readonly fields, custom XxxError extends Error with domain properties"
  - "cloud-test-mock: Use class syntax in vi.mock() for constructor mocks; inject mock clients via optional parameters for stateless functions"
  - "cloud-types: PascalCase interfaces with JSDoc, section dividers, camelCase fields"
  - "vitest-cloud-project: Separate 'cloud' test project in vitest.config.ts rooted at '.' including src/cloud/test/"

requirements-completed: [INFRA-02, INFRA-03, INFRA-04, INFRA-05]

# Metrics
duration: 6min
completed: 2026-04-15
---

# Phase 1 Plan 02: Cloud Service Clients Summary

**TypeScript service clients for Daytona sandbox lifecycle, S3 artifact storage, Postgres state persistence, and SQS job intake -- all with 41 passing unit tests using mocked dependencies**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-16T01:38:58Z
- **Completed:** 2026-04-16T01:45:13Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments
- Defined shared cloud domain types (PipelineRun, AgentRun, AgentTaskConfig, PipelineJobMessage, ArtifactKey) used across all service clients
- DaytonaClient wraps full sandbox lifecycle (create/clone/execute/delete) with guaranteed cleanup in finally block (D-07, Pitfall 1/5)
- S3 artifact functions with SHA256 checksums (Pitfall 6) and correct key path pattern runs/{runId}/phases/{phase}/{fileName} (D-12)
- Postgres client enforces SSL on all connections (T-02-02), uses parameterized queries exclusively (T-02-01), supports dynamic SET clause for updateAgentRun
- SQS consumer validates message payloads with isPipelineJobMessage type guard (T-02-03) before processing
- 41 unit tests pass across all 4 test files with fully mocked external dependencies

## Task Commits

Each task was committed atomically:

1. **Task 1: Create shared types and Daytona + S3 service clients with unit tests** - `35de00a` (feat)
2. **Task 2: Create Postgres and SQS service clients with unit tests** - `65d528c` (feat)

## Files Created/Modified
- `src/cloud/types.ts` - Shared type definitions for all cloud services (PipelineRun, AgentRun, AgentTaskConfig, PipelineJobMessage, ArtifactKey)
- `src/cloud/daytona-client.ts` - Daytona SDK wrapper for sandbox lifecycle with DaytonaClientError
- `src/cloud/s3-artifacts.ts` - S3 artifact upload/download/list with SHA256 checksums
- `src/cloud/postgres-client.ts` - Postgres connection pool + typed CRUD for pipeline_runs and agent_runs
- `src/cloud/sqs-consumer.ts` - SQS message consumer with PipelineJobMessage type guard validation
- `src/cloud/test/daytona-client.test.ts` - 7 tests for DaytonaClient (lifecycle, errors, cleanup)
- `src/cloud/test/s3-artifacts.test.ts` - 7 tests for S3 functions (upload, download, list, checksums)
- `src/cloud/test/postgres-client.test.ts` - 17 tests for Postgres client (pool config, CRUD, mappers)
- `src/cloud/test/sqs-consumer.test.ts` - 10 tests for SQS consumer (receive, parse, validate, delete)
- `package.json` - Added @daytonaio/sdk, @aws-sdk/*, pg dependencies
- `package-lock.json` - Dependency lockfile updated
- `vitest.config.ts` - Added 'cloud' test project for src/cloud/test/

## Decisions Made
- **DaytonaClientError naming:** Renamed from DaytonaError to DaytonaClientError to avoid collision with @daytonaio/sdk's built-in DaytonaError class
- **Class-based vi.mock pattern:** Used `class MockX { ... }` syntax inside vi.mock() instead of `vi.fn().mockImplementation()` because Vitest requires proper class constructors for `new` expressions
- **Injectable mock clients:** S3 functions accept optional `client` parameter to allow direct mock injection, avoiding constructor mocking issues entirely
- **Exported row mappers:** mapRowToPipelineRun and mapRowToAgentRun exported from postgres-client.ts for direct unit testing of mapping logic

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Adapted DaytonaClient API calls to match actual @daytonaio/sdk 0.166.0 signatures**
- **Found during:** Task 1
- **Issue:** Plan assumed `sandbox.process.executeCommand(cmd, cwd, envVars, timeout)` returns `{ exitCode, result }` (not `stdout`), and `sandbox.delete()` is on the sandbox object (not via `daytona.delete(sandbox)`)
- **Fix:** Used correct SDK API signatures from the installed .d.ts types; mapped `response.result` to `stdout` in return value
- **Files modified:** src/cloud/daytona-client.ts
- **Committed in:** 35de00a

**2. [Rule 1 - Bug] Fixed Vitest constructor mock pattern for all test files**
- **Found during:** Task 1 (first test run)
- **Issue:** `vi.fn().mockImplementation(() => ({...}))` does not produce a valid constructor; all tests failed with "is not a constructor"
- **Fix:** Changed to class-based mock syntax `class MockX { ... }` and optional client parameter injection
- **Files modified:** src/cloud/test/daytona-client.test.ts, src/cloud/test/s3-artifacts.test.ts
- **Committed in:** 35de00a

---

**Total deviations:** 2 auto-fixed (2 Rule 1 bugs)
**Impact on plan:** Both fixes necessary for correctness. No scope creep. All acceptance criteria met.

## Issues Encountered
None beyond the deviations documented above.

## Threat Mitigations Verified

| Threat ID | Mitigation | Verified |
|-----------|-----------|----------|
| T-02-01 | Parameterized SQL queries ($1, $2, ...) | All postgres-client.ts queries use parameterized placeholders; tested in postgres-client.test.ts |
| T-02-02 | SSL enforcement (rejectUnauthorized: true) | createDbPool always sets ssl config; tested in postgres-client.test.ts |
| T-02-03 | Type guard isPipelineJobMessage() | SQS consumer validates all required fields; tested with invalid payloads in sqs-consumer.test.ts |
| T-02-04 | API key via constructor (not hardcoded) | DaytonaClient accepts apiKey in constructor opts |
| T-02-05 | Sandbox cleanup in finally block | DaytonaClient.executeTask always deletes sandbox; tested with failing command in daytona-client.test.ts |
| T-02-06 | SHA256 checksum on S3 PutObject | uploadArtifact sets ChecksumAlgorithm: 'SHA256'; tested in s3-artifacts.test.ts |

## User Setup Required

None - no external service configuration required. All tests use mocked dependencies.

## Next Phase Readiness
- All 5 source modules and 4 test files ready for Plan 01-03 (e2e validation)
- Types in src/cloud/types.ts provide the shared contract for CDK stack (Plan 01-01) and e2e validation (Plan 01-03)
- Service clients ready to be wired to real AWS resources once CDK stack is deployed

## Self-Check: PASSED

- All 10 files verified present on disk
- Both task commits (35de00a, 65d528c) verified in git log
- All 41 unit tests passing

---
*Phase: 01-aws-foundation-agent-runtime*
*Completed: 2026-04-15*

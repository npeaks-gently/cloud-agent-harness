/**
 * Pipeline orchestrator type definitions.
 *
 * These types model the pipeline stage lifecycle, inter-stage messaging,
 * agent task outcomes, and the idempotent upsert data contract. They
 * complement (not duplicate) the base domain types in `src/cloud/types.ts`.
 *
 * @see D-09 Pipeline stages
 * @see D-15 Idempotent task IDs
 */

// --- Pipeline stage enum -----------------------------------------------------

/**
 * All stages in the pipeline lifecycle (D-09).
 *
 * Each pipeline run progresses through these stages sequentially.
 * The Approve stage is auto-approve until Phase 3 (Slack integration, D-10).
 */
export enum PipelineStage {
  /** Initial intake -- creates pipeline_run, validates input */
  Intake = 'intake',
  /** Research phase -- spawns research agent(s) in Daytona */
  Research = 'research',
  /** Planning phase -- spawns planning agent */
  Plan = 'plan',
  /** Approval gate -- auto-approve until Phase 3 Slack integration */
  Approve = 'approve',
  /** Execution phase -- spawns executor agents per plan/wave */
  Execute = 'execute',
  /** Verification phase -- spawns verifier agent */
  Verify = 'verify',
  /** PR creation -- creates pull request from accumulated artifacts */
  PR = 'pr',
}

// --- Stage transition map ----------------------------------------------------

/**
 * Maps each pipeline stage to its successor.
 *
 * PR is the terminal stage and maps to `null`. Used by the stage router
 * to determine the next SQS message after a stage completes.
 */
export const NEXT_STAGE: Record<PipelineStage, PipelineStage | null> = {
  [PipelineStage.Intake]: PipelineStage.Research,
  [PipelineStage.Research]: PipelineStage.Plan,
  [PipelineStage.Plan]: PipelineStage.Approve,
  [PipelineStage.Approve]: PipelineStage.Execute,
  [PipelineStage.Execute]: PipelineStage.Verify,
  [PipelineStage.Verify]: PipelineStage.PR,
  [PipelineStage.PR]: null,
};

// --- Inter-stage message types -----------------------------------------------

/**
 * SQS message payload sent between pipeline stages.
 *
 * Each stage Lambda receives this message from SQS, processes the stage,
 * and sends a new StageMessage for the next stage via NEXT_STAGE.
 */
export interface StageMessage {
  /** Pipeline run UUID */
  runId: string;
  /** Project identifier */
  projectId: string;
  /** Git repository URL for the target codebase */
  repoUrl: string;
  /** Branch to work on */
  branch: string;
  /** Current pipeline stage to execute */
  stage: PipelineStage;
  /** Contextual data accumulated across stages */
  context: {
    /** Human-readable description of the feature or task */
    featureDescription: string;
    /** Current phase number being executed */
    phaseNumber: number;
    /** Total number of phases in the pipeline */
    phaseTotal: number;
    /** S3 artifact keys produced by previous stages */
    previousArtifacts: string[];
    /** Feature branch name created at intake (Phase 3, D-05). */
    featureBranch?: string;
    /** Linear parent ticket ID created at intake (Phase 3, D-09). */
    linearParentTicketId?: string;
    /** S3 key prefix for pre-uploaded planning context (D-13) */
    planningPrefix?: string;
  };
}

// --- Stage result types ------------------------------------------------------

/**
 * Result returned by a stage handler after execution.
 *
 * Contains the overall stage status and individual task outcomes.
 * Used by the stage router to decide whether to advance or fail.
 */
export interface StageResult {
  /** Which stage produced this result */
  stage: PipelineStage;
  /** Overall outcome of the stage */
  status: 'completed' | 'failed' | 'skipped' | 'paused';
  /** Individual agent task outcomes within this stage */
  tasks: AgentTaskOutcome[];
  /** Error message if status is 'failed' */
  error?: string;
}

/**
 * Token usage breakdown reported by an agent task.
 *
 * Mirrors the SDK's SessionUsage. Cache tokens dominate Anthropic cost
 * calculations so they are tracked separately from input/output.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Outcome of a single agent task within a pipeline stage.
 *
 * Each stage may dispatch one or more agent tasks (e.g., execute stage
 * spawns agents per plan/wave). This captures the result of each.
 */
export interface AgentTaskOutcome {
  /** Deterministic task key (runId:phase:plan:wave) */
  taskKey: string;
  /** Whether the task completed successfully */
  success: boolean;
  /** Process exit code from the agent sandbox */
  exitCode: number;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Cost in USD for this task */
  costUsd: number;
  /** S3 artifact keys produced by this task */
  artifacts: string[];
  /** Error message if the task failed */
  error?: string;
  /** Token usage breakdown (undefined when sandbox stdout did not include it). */
  usage?: AgentUsage;
  /** Concrete model ID that executed the task (e.g., "claude-sonnet-4-6"). */
  model?: string;
}

// --- Idempotent upsert data --------------------------------------------------

/**
 * Input data for the idempotent agent run upsert.
 *
 * Maps to the columns written during INSERT ... ON CONFLICT (task_key).
 * Does not include task_key itself -- that is passed separately to
 * distinguish the conflict target from the data payload.
 */
export interface AgentRunData {
  /** Parent pipeline run UUID */
  pipelineRunId: string;
  /** Phase number the agent is executing */
  phase: number;
  /** Plan name within the phase (e.g., "02-01") */
  planName: string;
  /** Execution wave for parallel coordination */
  wave: number;
  /** Current execution status */
  status: 'pending' | 'running' | 'completed' | 'failed';
}

// --- Error -------------------------------------------------------------------

/**
 * Error thrown by pipeline orchestrator operations.
 *
 * Includes the operation name and optionally the pipeline stage
 * where the error occurred. Follows the shared error class pattern
 * from postgres-client.ts and daytona-client.ts.
 *
 * @see T-02-02 Error messages include operation name but never parameter values.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly stage?: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

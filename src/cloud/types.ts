/**
 * Core type definitions for cloud service clients.
 *
 * These types model the domain objects shared across Daytona sandbox
 * management, S3 artifact storage, Postgres state persistence, and
 * SQS job intake.
 */

// ─── Pipeline types ─────────────────────────────────────────────────────────

/** Represents a single pipeline execution tracking record. */
export interface PipelineRun {
  /** Unique identifier (UUID) for the pipeline run */
  id: string;
  /** Project this run belongs to */
  projectId: string;
  /** Current execution status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Current phase number being executed */
  phaseCurrent: number;
  /** Total number of phases in the pipeline */
  phaseTotal: number;
  /** Arbitrary configuration for this run */
  config: Record<string, unknown>;
  /** Git repository URL (stored in dedicated column at intake) */
  repoUrl: string;
  /** Base branch name (stored in dedicated column at intake) */
  branch: string;
  /** Human-readable feature description */
  featureDescription: string;
  /** Current pipeline stage (set by stage-router and checkpoint) */
  currentStage?: string;
  /** Feature branch name created at intake (D-05) */
  featureBranch?: string;
  /** Linear parent ticket ID created at intake (D-09) */
  linearParentTicketId?: string;
  /** When the run was created */
  createdAt: Date;
  /** When the run was last updated */
  updatedAt: Date;
}

// ─── Agent types ────────────────────────────────────────────────────────────

/** Represents a single agent task execution within a pipeline run. */
export interface AgentRun {
  /** Unique identifier (UUID) for the agent run */
  id: string;
  /** Parent pipeline run this agent belongs to */
  pipelineRunId: string;
  /** Phase number the agent is executing */
  phase: number;
  /** Plan name within the phase (e.g., "01-02") */
  planName: string;
  /** Execution wave for parallel coordination */
  wave: number;
  /** Current execution status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Claude API session identifier */
  sessionId?: string;
  /** Model used for this agent run (e.g., "claude-opus-4-20250514") */
  model?: string;
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens generated */
  outputTokens: number;
  /** Total cost in USD */
  costUsd: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Error message if status is 'failed' */
  errorMessage?: string;
  /** S3 artifact keys produced by this agent */
  artifacts: string[];
  /** When the agent started executing */
  startedAt?: Date;
  /** When the agent completed (success or failure) */
  completedAt?: Date;
  /** When the agent run record was created */
  createdAt: Date;
}

// ─── Daytona types ──────────────────────────────────────────────────────────

/** Configuration for executing a task inside a Daytona sandbox. */
export interface AgentTaskConfig {
  /** Git repository URL to clone into the sandbox */
  repoUrl: string;
  /** Branch to checkout after cloning */
  branch: string;
  /** Environment variables injected into the sandbox */
  envVars: Record<string, string>;
  /** Shell command to execute inside the sandbox */
  command: string;
  /** Maximum execution time in seconds (default: 300) */
  timeoutSeconds?: number;
  /** Resource allocation for the sandbox */
  resources?: { cpu?: number; memory?: number };
}

/** Result from executing a task inside a Daytona sandbox. */
export interface AgentTaskResult {
  /** Process exit code (0 = success) */
  exitCode: number;
  /** Standard output captured from the command */
  stdout: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

// ─── S3 types ───────────────────────────────────────────────────────────────

/** Structured key components for S3 artifact paths. */
export interface ArtifactKey {
  /** Pipeline run ID for namespacing */
  runId: string;
  /** Phase identifier (e.g., "01") */
  phase: string;
  /** File name within the phase artifacts */
  fileName: string;
}

// ─── SQS types ──────────────────────────────────────────────────────────────

/** Message payload received from the SQS pipeline job queue. */
export interface PipelineJobMessage {
  /** Project identifier this job targets */
  projectId: string;
  /** Git repository URL for the target codebase */
  repoUrl: string;
  /** Branch to work on */
  branch: string;
  /** Human-readable description of the feature or task */
  featureDescription: string;
  /** Optional additional configuration */
  config?: Record<string, unknown>;
  /** S3 key prefix where pre-uploaded .planning/ artifacts are stored (D-13) */
  planningPrefix?: string;
}

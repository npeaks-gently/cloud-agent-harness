-- Cloud Agent Harness -- Migration 002: Idempotent task keys
-- Run against the cah database after CDK deploy:
--   psql "$DATABASE_URL" -f scripts/migrate-002-idempotency.sql

-- Add deterministic task key for idempotent replay (D-15)
-- Format: {runId}:{phase}:{plan}:{wave}
-- Nullable because existing rows predate idempotency support.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS task_key TEXT;

-- Unique partial index on task_key -- only enforced for non-null values.
-- Prevents duplicate agent_run rows when a pipeline stage is replayed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_task_key
  ON agent_runs(task_key) WHERE task_key IS NOT NULL;

-- Add stage tracking to pipeline_runs (D-14)
-- Tracks which pipeline stage is currently executing.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS current_stage TEXT DEFAULT 'intake';

-- Add fields extracted from PipelineJobMessage for pipeline-level context.
-- These are denormalized from the initial SQS message for query convenience.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS repo_url TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS branch TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS feature_description TEXT;

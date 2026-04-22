-- Cloud Agent Harness -- Migration 003: Approval tokens + integration fields
-- Run against the cah database after CDK deploy:
--   psql "$DATABASE_URL" -f scripts/migrate-003-approvals.sql

-- Approval token table for Slack plan-approval gate (D-01).
-- The approve stage writes a pending row with a UUID token; the Slack
-- webhook Lambda validates the token and re-enqueues the next stage.
CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  token UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  slack_channel TEXT,
  slack_message_ts TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

-- Fast lookup by approval token (Slack webhook hot path).
CREATE INDEX IF NOT EXISTS idx_approvals_token ON approvals(token);

-- Find all approvals for a given pipeline run.
CREATE INDEX IF NOT EXISTS idx_approvals_pipeline_run ON approvals(pipeline_run_id);

-- Feature branch and Linear ticket tracking on pipeline_runs (D-05, D-09).
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS feature_branch TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS linear_parent_ticket_id TEXT;

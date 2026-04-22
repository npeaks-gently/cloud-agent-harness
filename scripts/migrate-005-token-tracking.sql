-- Cloud Agent Harness -- Migration 005: Token breakdown columns
-- Run against the cah database after CDK deploy:
--   psql "$DATABASE_URL" -f scripts/migrate-005-token-tracking.sql

-- Cache tokens dominate Anthropic costs; tracking them alongside
-- input/output is required to debug per-stage cost breakdowns.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER DEFAULT 0;

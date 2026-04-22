-- Cloud Agent Harness -- Migration 004: Approval type discriminator
-- Adds approval_type column to distinguish plan approvals from risk escalations (D-06).
-- Run against the cah database after CDK deploy:
--   psql "$DATABASE_URL" -f scripts/migrate-004-approval-type.sql

-- Add approval_type discriminator column. Existing rows default to 'plan_approval'
-- ensuring backward compatibility (Pitfall 5 from RESEARCH.md).
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approval_type TEXT NOT NULL DEFAULT 'plan_approval';

-- Index for filtering approvals by type (webhook handler routing).
CREATE INDEX IF NOT EXISTS idx_approvals_type ON approvals(approval_type);

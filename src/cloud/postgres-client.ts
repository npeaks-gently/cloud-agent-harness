/**
 * Postgres connection pool + typed queries for pipeline_runs and agent_runs.
 *
 * Provides a connection pool factory with SSL enforcement (T-02-02),
 * parameterized queries for all operations (T-02-01), and helper
 * functions to map snake_case DB columns to camelCase TypeScript fields.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type { PipelineRun, AgentRun } from './types.js';

// ─── RDS CA certificate ────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const RDS_CA_BUNDLE_PATH = process.env.RDS_CA_BUNDLE_PATH
  ?? resolve(__dirname, '../../infra/certs/rds-global-bundle.pem');

/**
 * Load the RDS global CA bundle for SSL certificate verification.
 * Returns undefined only in test environments. In production, throws
 * if the cert file is missing to prevent silent SSL downgrade.
 */
function loadRdsCaCert(): Buffer | undefined {
  try {
    return readFileSync(RDS_CA_BUNDLE_PATH);
  } catch {
    if (process.env.NODE_ENV === 'test') return undefined;
    throw new Error(
      `RDS CA bundle not found at ${RDS_CA_BUNDLE_PATH}. ` +
      'Ensure infra/certs/rds-global-bundle.pem is included in the Lambda package.',
    );
  }
}

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by Postgres client operations.
 * Includes the operation that failed and optionally the SQL query.
 */
export class PostgresClientError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly query?: string,
  ) {
    super(message);
    this.name = 'PostgresClientError';
  }
}

// ─── Connection pool ────────────────────────────────────────────────────────

/**
 * Creates a Postgres connection pool with SSL enforcement.
 *
 * SSL is always enabled with `rejectUnauthorized: true` (T-02-02)
 * to prevent man-in-the-middle attacks on the Daytona-to-RDS connection.
 *
 * @param connectionString - PostgreSQL connection string (from Secrets Manager)
 * @returns Configured Pool instance
 */
export function createDbPool(connectionString: string): Pool {
  const ca = loadRdsCaCert();
  const config: PoolConfig = {
    connectionString,
    ssl: ca
      ? { rejectUnauthorized: true, ca }
      : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };

  return new Pool(config);
}

// ─── Row mappers ────────────────────────────────────────────────────────────

/**
 * Maps a snake_case DB row to a camelCase PipelineRun interface.
 */
function mapRowToPipelineRun(row: Record<string, unknown>): PipelineRun {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    status: row.status as PipelineRun['status'],
    phaseCurrent: row.phase_current as number,
    phaseTotal: row.phase_total as number,
    config: (typeof row.config === 'string'
      ? JSON.parse(row.config)
      : row.config ?? {}) as Record<string, unknown>,
    repoUrl: (row.repo_url as string) ?? '',
    branch: (row.branch as string) ?? '',
    featureDescription: (row.feature_description as string) ?? '',
    featureBranch: row.feature_branch as string | undefined,
    linearParentTicketId: row.linear_parent_ticket_id as string | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Maps a snake_case DB row to a camelCase AgentRun interface.
 */
function mapRowToAgentRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    pipelineRunId: row.pipeline_run_id as string,
    phase: row.phase as number,
    planName: row.plan_name as string,
    wave: row.wave as number,
    status: row.status as AgentRun['status'],
    sessionId: row.session_id as string | undefined,
    model: row.model as string | undefined,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    costUsd: (row.cost_usd as number) ?? 0,
    durationMs: (row.duration_ms as number) ?? 0,
    errorMessage: row.error_message as string | undefined,
    artifacts: (row.artifacts as string[]) ?? [],
    startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  };
}

// ─── Pipeline run queries ───────────────────────────────────────────────────

/**
 * Inserts a new pipeline run record.
 *
 * @param pool - Postgres connection pool
 * @param projectId - Project identifier
 * @param phaseTotal - Total number of phases
 * @param config - Arbitrary JSON configuration
 * @returns Generated UUID for the new pipeline run
 */
export async function insertPipelineRun(
  pool: Pool,
  projectId: string,
  phaseTotal: number,
  config: Record<string, unknown>,
): Promise<string> {
  const sql = `
    INSERT INTO pipeline_runs (project_id, phase_total, config)
    VALUES ($1, $2, $3)
    RETURNING id
  `;

  try {
    const result = await pool.query(sql, [projectId, phaseTotal, JSON.stringify(config)]);
    return result.rows[0].id as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to insert pipeline run: ${message}`,
      'insertPipelineRun',
      sql,
    );
  }
}

/**
 * Retrieves a pipeline run by ID.
 *
 * @param pool - Postgres connection pool
 * @param id - Pipeline run UUID
 * @returns PipelineRun or null if not found
 */
export async function getPipelineRun(
  pool: Pool,
  id: string,
): Promise<PipelineRun | null> {
  const sql = `SELECT * FROM pipeline_runs WHERE id = $1`;

  try {
    const result = await pool.query(sql, [id]);
    if (result.rows.length === 0) return null;
    return mapRowToPipelineRun(result.rows[0] as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to get pipeline run: ${message}`,
      'getPipelineRun',
      sql,
    );
  }
}

// ─── Agent run queries ──────────────────────────────────────────────────────

/**
 * Inserts a new agent run with status 'running' and started_at = NOW().
 *
 * @param pool - Postgres connection pool
 * @param pipelineRunId - Parent pipeline run UUID
 * @param phase - Phase number
 * @param planName - Plan name within the phase
 * @param wave - Execution wave
 * @returns Generated UUID for the new agent run
 */
export async function insertAgentRun(
  pool: Pool,
  pipelineRunId: string,
  phase: number,
  planName: string,
  wave: number,
): Promise<string> {
  const sql = `
    INSERT INTO agent_runs (pipeline_run_id, phase, plan_name, wave, status, started_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id
  `;

  try {
    const result = await pool.query(sql, [pipelineRunId, phase, planName, wave, 'running']);
    return result.rows[0].id as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to insert agent run: ${message}`,
      'insertAgentRun',
      sql,
    );
  }
}

/**
 * Updates an existing agent run with dynamic fields.
 *
 * Builds a parameterized SET clause from non-undefined fields.
 * Automatically sets `completed_at = NOW()` when status is 'completed' or 'failed'.
 *
 * @param pool - Postgres connection pool
 * @param id - Agent run UUID
 * @param update - Fields to update (only non-undefined fields are applied)
 */
export async function updateAgentRun(
  pool: Pool,
  id: string,
  update: {
    status?: string;
    sessionId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs?: number;
    errorMessage?: string;
    artifacts?: string[];
  },
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  // Map camelCase fields to snake_case columns
  const fieldMap: Array<[string, unknown]> = [
    ['status', update.status],
    ['session_id', update.sessionId],
    ['model', update.model],
    ['input_tokens', update.inputTokens],
    ['output_tokens', update.outputTokens],
    ['cost_usd', update.costUsd],
    ['duration_ms', update.durationMs],
    ['error_message', update.errorMessage],
    ['artifacts', update.artifacts],
  ];

  for (const [column, value] of fieldMap) {
    if (value !== undefined) {
      setClauses.push(`${column} = $${paramIndex}`);
      values.push(column === 'artifacts' ? JSON.stringify(value) : value);
      paramIndex++;
    }
  }

  // Auto-set completed_at when status indicates terminal state
  if (update.status === 'completed' || update.status === 'failed') {
    setClauses.push('completed_at = NOW()');
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const sql = `UPDATE agent_runs SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;

  try {
    await pool.query(sql, values);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to update agent run: ${message}`,
      'updateAgentRun',
      sql,
    );
  }
}

// ─── Approval queries ──────────────────────────────────────────────────────

/**
 * Inserts a new approval record for the Slack approval gate.
 *
 * Uses ON CONFLICT (token) DO NOTHING for idempotent replay safety.
 *
 * @param pool - Postgres connection pool
 * @param pipelineRunId - Parent pipeline run UUID
 * @param token - Unique approval token (UUID) embedded in Slack buttons
 * @param slackChannel - Slack channel ID where the approval message was sent
 * @param slackMessageTs - Slack message timestamp for updating the message later
 * @param approvalType - Type of approval ('plan_approval' or 'risk_escalation'), defaults to 'plan_approval'
 * @returns Generated UUID for the new approval row
 */
export async function insertApproval(
  pool: Pool,
  pipelineRunId: string,
  token: string,
  slackChannel: string,
  slackMessageTs: string,
  approvalType: string = 'plan_approval',
): Promise<string> {
  const sql = `
    INSERT INTO approvals (pipeline_run_id, token, slack_channel, slack_message_ts, approval_type)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (token) DO NOTHING
    RETURNING id
  `;

  try {
    const result = await pool.query(sql, [pipelineRunId, token, slackChannel, slackMessageTs, approvalType]);
    // ON CONFLICT DO NOTHING returns no rows on conflict -- return empty string
    return (result.rows[0]?.id as string) ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to insert approval: ${message}`,
      'insertApproval',
      sql,
    );
  }
}

/**
 * Retrieves an approval by its unique token.
 *
 * @param pool - Postgres connection pool
 * @param token - Approval token UUID
 * @returns Approval row or null if not found
 */
export async function getApprovalByToken(
  pool: Pool,
  token: string,
): Promise<{
  id: string;
  pipelineRunId: string;
  status: string;
  slackChannel: string | null;
  requestedAt: Date;
  approvalType: string;
} | null> {
  const sql = `
    SELECT id, pipeline_run_id, status, slack_channel, requested_at, approval_type
    FROM approvals
    WHERE token = $1
  `;

  try {
    const result = await pool.query(sql, [token]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      pipelineRunId: row.pipeline_run_id as string,
      status: row.status as string,
      slackChannel: row.slack_channel as string | null,
      requestedAt: new Date(row.requested_at as string),
      approvalType: (row.approval_type as string) ?? 'plan_approval',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to get approval by token: ${message}`,
      'getApprovalByToken',
      sql,
    );
  }
}

/**
 * Resolves an approval by setting its status and recording who resolved it.
 *
 * Only pending approvals can be resolved (T-03-04: status transition guard).
 * Returns true if a row was actually updated, false if the approval was
 * already resolved (e.g., concurrent double-click race).
 *
 * @param pool - Postgres connection pool
 * @param token - Approval token UUID
 * @param status - Resolution status ('approved' or 'rejected')
 * @param resolvedBy - Identifier of who resolved the approval (Slack user ID)
 * @returns true if a pending approval was resolved, false if no rows matched
 */
export async function resolveApproval(
  pool: Pool,
  token: string,
  status: 'approved' | 'rejected',
  resolvedBy: string,
): Promise<boolean> {
  const sql = `
    UPDATE approvals
    SET status = $1, resolved_at = NOW(), resolved_by = $2
    WHERE token = $3 AND status = 'pending'
  `;

  try {
    const result = await pool.query(sql, [status, resolvedBy, token]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to resolve approval: ${message}`,
      'resolveApproval',
      sql,
    );
  }
}

// ─── Pipeline run updates ──────────────────────────────────────────────────

/**
 * Updates the feature branch name on a pipeline run.
 *
 * @param pool - Postgres connection pool
 * @param runId - Pipeline run UUID
 * @param featureBranch - Feature branch name (e.g., cah/{run_id_short}/{slug})
 */
export async function updatePipelineRunBranch(
  pool: Pool,
  runId: string,
  featureBranch: string,
): Promise<void> {
  const sql = `UPDATE pipeline_runs SET feature_branch = $1 WHERE id = $2`;

  try {
    await pool.query(sql, [featureBranch, runId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to update pipeline run branch: ${message}`,
      'updatePipelineRunBranch',
      sql,
    );
  }
}

/**
 * Updates the Linear parent ticket ID on a pipeline run.
 *
 * @param pool - Postgres connection pool
 * @param runId - Pipeline run UUID
 * @param linearParentTicketId - Linear issue ID for the parent ticket
 */
export async function updatePipelineRunLinearTicket(
  pool: Pool,
  runId: string,
  linearParentTicketId: string,
): Promise<void> {
  const sql = `UPDATE pipeline_runs SET linear_parent_ticket_id = $1 WHERE id = $2`;

  try {
    await pool.query(sql, [linearParentTicketId, runId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PostgresClientError(
      `Failed to update pipeline run Linear ticket: ${message}`,
      'updatePipelineRunLinearTicket',
      sql,
    );
  }
}

// Re-export mappers for testing
export { mapRowToPipelineRun, mapRowToAgentRun };

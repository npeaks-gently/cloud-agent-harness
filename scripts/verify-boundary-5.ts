/**
 * Boundary 5 verification: Intake → Postgres (insertPipelineRun)
 *
 * Inserts a pipeline_runs row using the same SQL as intake.ts,
 * reads it back, verifies all fields, then cleans up.
 *
 * Usage: NODE_OPTIONS="" npx tsx scripts/verify-boundary-5.ts
 *
 * Requires: DATABASE_URL env var pointing to the cah RDS instance.
 *   export DATABASE_URL="postgres://user:pass@host:5432/cah?sslmode=require"
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const { Pool } = pg;

async function getDbUrl(): Promise<string> {
  // Check env first
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Fall back to Secrets Manager
  const secretArn = 'arn:aws:secretsmanager:us-east-1:659828095854:secret:CahStackDatabaseInstanceSec-4tdMv7TNnEGn-mzU7v3';
  const sm = new SecretsManagerClient({ region: 'us-east-1' });
  const result = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) throw new Error('Empty secret');
  const secret = JSON.parse(result.SecretString);
  return `postgres://${secret.username}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${secret.dbname}?sslmode=require`;
}

async function main(): Promise<void> {
  console.log('=== Boundary 5: Intake → Postgres (live DB round-trip) ===\n');

  const dbUrl = await getDbUrl();
  const pool = new Pool({ connectionString: dbUrl, max: 1, ssl: { rejectUnauthorized: false } });

  const runId = randomUUID();
  const projectId = 'boundary-test-5';
  const phaseTotal = 3;
  const config = JSON.stringify({ featureDescription: 'Boundary 5 test' });
  const repoUrl = 'https://github.com/test/verify';
  const branch = 'main';
  const featureDescription = 'Boundary 5 verification test';

  try {
    // 1. Insert using the same SQL as intake.ts:64-68
    console.log('--- Inserting pipeline_run (intake SQL) ---');
    const insertSql = `
      INSERT INTO pipeline_runs (id, project_id, phase_total, config, status, repo_url, branch, feature_description)
      VALUES ($1::uuid, $2, $3, $4, 'running', $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `;
    await pool.query(insertSql, [runId, projectId, phaseTotal, config, repoUrl, branch, featureDescription]);
    console.log(`  Inserted run: ${runId}`);

    // 2. Read it back
    console.log('\n--- Reading back ---');
    const result = await pool.query('SELECT * FROM pipeline_runs WHERE id = $1', [runId]);
    if (result.rows.length === 0) {
      console.error('FAIL: Row not found after insert');
      process.exit(1);
    }
    const row = result.rows[0];
    console.log('  Row:', JSON.stringify(row, null, 2));

    // 3. Verify fields
    console.log('\n--- Checks ---');
    let allPassed = true;

    const checks: [string, boolean][] = [
      ['id matches', row.id === runId],
      ['project_id matches', row.project_id === projectId],
      ['status is running', row.status === 'running'],
      ['phase_total matches', row.phase_total === phaseTotal],
      ['repo_url matches', row.repo_url === repoUrl],
      ['branch matches', row.branch === branch],
      ['feature_description matches', row.feature_description === featureDescription],
      ['config is valid JSONB', typeof row.config === 'object' && row.config.featureDescription === 'Boundary 5 test'],
      ['created_at is a Date', row.created_at instanceof Date],
      ['updated_at is a Date', row.updated_at instanceof Date],
    ];

    for (const [name, passed] of checks) {
      console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}`);
      if (!passed) allPassed = false;
    }

    // 4. Test idempotency (ON CONFLICT DO NOTHING)
    console.log('\n--- Idempotency check ---');
    const { rowCount } = await pool.query(insertSql, [runId, projectId, phaseTotal, config, repoUrl, branch, featureDescription]);
    const idempotent = rowCount === 0; // 0 rows affected on conflict
    console.log(`  [${idempotent ? 'PASS' : 'FAIL'}] Re-insert returns 0 rows affected (ON CONFLICT DO NOTHING)`);
    if (!idempotent) allPassed = false;

    // 5. Cleanup
    console.log('\n--- Cleanup ---');
    await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
    console.log(`  Deleted run: ${runId}`);

    console.log(`\n=== Boundary 5: ${allPassed ? 'PASS' : 'FAIL'} ===`);
    if (!allPassed) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

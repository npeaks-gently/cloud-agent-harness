import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function main() {
  const sm = new SecretsManagerClient({ region: 'us-east-1' });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: 'arn:aws:secretsmanager:us-east-1:659828095854:secret:CahStackDatabaseInstanceSec-4tdMv7TNnEGn-mzU7v3' }));
  const s = JSON.parse(r.SecretString!);
  const pool = new pg.Pool({
    connectionString: `postgres://${s.username}:${encodeURIComponent(s.password)}@${s.host}:${s.port}/${s.dbname}`,
    ssl: { rejectUnauthorized: false },
  });

  console.log('Applying migration 004: approval_type column...');
  await pool.query(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approval_type TEXT NOT NULL DEFAULT 'plan_approval'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approvals_type ON approvals(approval_type)`);

  // Verify
  const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'approvals' ORDER BY ordinal_position`);
  console.log('approvals columns:', res.rows.map((r: { column_name: string }) => r.column_name));
  console.log('Done.');
  await pool.end();
}

main().catch(console.error);

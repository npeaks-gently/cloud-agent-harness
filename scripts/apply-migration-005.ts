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

  console.log('Applying migration 005: cache_read_tokens / cache_creation_tokens columns...');
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER DEFAULT 0`);

  const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_runs' ORDER BY ordinal_position`);
  console.log('agent_runs columns:', res.rows.map((r: { column_name: string }) => r.column_name));
  console.log('Done.');
  await pool.end();
}

main().catch(console.error);

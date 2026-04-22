#!/bin/bash
set -euo pipefail

SECRET_ID="CahStackDatabaseInstanceSec-4tdMv7TNnEGn"

echo "Fetching DB credentials from Secrets Manager..."
DATABASE_URL=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" \
  --query 'SecretString' \
  --output text | node -e "
    const s=require('fs').readFileSync('/dev/stdin','utf8');
    const c=JSON.parse(s);
    console.log('postgresql://'+c.username+':'+encodeURIComponent(c.password)+'@'+c.host+':'+c.port+'/'+c.dbname);
  ")

echo "Running migration..."
psql "$DATABASE_URL" -f scripts/migrate-003-approvals.sql

echo ""
echo "Verifying schema..."
psql "$DATABASE_URL" -c "\dt approvals"
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='approvals' ORDER BY ordinal_position;"
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='pipeline_runs' AND column_name IN ('feature_branch','linear_parent_ticket_id');"

echo ""
echo "Done."

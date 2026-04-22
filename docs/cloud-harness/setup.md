# Cloud Agent Harness Setup

> Prerequisites and deployment steps for running the cloud infrastructure.

---

## Prerequisites

1. **Node.js >= 22.0.0** — required by the project
2. **AWS CLI** — install and configure with credentials
3. **AWS account** with `AdministratorAccess` (or equivalent permissions covering CloudFormation, EC2, RDS, S3, SQS, IAM, Secrets Manager, SSM, STS)

### Install AWS CLI

```bash
brew install awscli
```

### Configure credentials

```bash
aws configure
```

You'll be prompted for:

| Field | Value |
|-------|-------|
| AWS Access Key ID | From IAM console > Users > your user > Security credentials > Create access key |
| AWS Secret Access Key | Shown once when you create the key |
| Default region | `us-east-1` |
| Default output format | `json` |

Verify your credentials work:

```bash
aws sts get-caller-identity
```

You should see your account ID and user ARN.

---

## Deploy

### 1. Install CDK dependencies

```bash
cd infra && npm install
```

### 2. Bootstrap CDK (one-time per account/region)

CDK needs a staging bucket and roles in your AWS account before it can deploy stacks. This only needs to be done once per account/region combination.

```bash
npx aws-cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1
```

Replace `YOUR_ACCOUNT_ID` with the number from `aws sts get-caller-identity`.

### 3. Synthesize (optional, validates locally)

```bash
npx aws-cdk synth
```

Produces the CloudFormation template without making any AWS calls. If this succeeds, the template is valid.

### 4. Deploy

```bash
npx aws-cdk deploy
```

CDK will show you the changeset and ask for confirmation before creating resources. IAM changes trigger an additional security approval prompt.

When complete, the stack outputs will print:

| Output | Description |
|--------|-------------|
| `BucketName` | S3 pipeline artifact bucket |
| `DbEndpoint` | RDS Postgres endpoint address |
| `QueueUrl` | SQS job queue URL |
| `SecretArn` | Secrets Manager ARN for DB credentials |

### 5. Initialize database schema

After deploy, create the tables in the RDS Postgres instance. You'll need the database connection string from the deploy outputs and the Secrets Manager secret.

```bash
# Retrieve the DB credentials from Secrets Manager (use the SecretArn from deploy output)
aws secretsmanager get-secret-value \
  --secret-id "$(aws cloudformation describe-stacks --stack-name CahStack \
    --query 'Stacks[0].Outputs[?OutputKey==`SecretArn`].OutputValue' --output text)" \
  --query SecretString --output text | jq .

# This returns JSON with: host, port, username, password, dbname
# Connect and run the schema script
psql "postgresql://USERNAME:PASSWORD@DB_ENDPOINT:5432/cah" \
  -f scripts/init-db-schema.sql
```

Replace `USERNAME`, `PASSWORD`, and `DB_ENDPOINT` with the values from the secret JSON and the `DbEndpoint` stack output.

---

## Validate

Run the end-to-end validation script to prove the full chain works:

```bash
DATABASE_URL="postgresql://cah_admin:PASSWORD@DB_ENDPOINT:5432/cah" \
S3_BUCKET="cah-dev-pipeline-bucket" \
SQS_QUEUE_URL="QUEUE_URL_FROM_OUTPUT" \
DAYTONA_API_KEY="your-daytona-api-key" \
ANTHROPIC_API_KEY="your-anthropic-api-key" \
REPO_URL="https://github.com/your-org/your-repo.git" \
npx tsx scripts/validate-phase1.ts
```

Expected output: all 4 steps PASS (INFRA-02 through INFRA-05).

---

## Tear Down

To remove all AWS resources:

```bash
cd infra && npx aws-cdk destroy
```

This deletes the entire stack. The S3 bucket and RDS instance have `DESTROY` removal policies, so they will be deleted (not retained). This is a dev configuration — production would use `RETAIN`.

---

## Costs

Approximate monthly cost for the dev stack (idle):

| Resource | Cost |
|----------|------|
| RDS db.t4g.micro | ~$12/mo |
| S3 (minimal storage) | < $1/mo |
| SQS (low volume) | < $1/mo |
| Secrets Manager (2 secrets) | ~$1/mo |
| NAT Gateway | $0 (none provisioned) |
| **Total** | **~$15/mo** |

RDS is the main cost driver. Stop the instance when not in use to reduce cost, or use `cdk destroy` to tear down entirely between sessions.

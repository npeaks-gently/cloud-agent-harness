/**
 * Slack webhook Lambda handler for interactive payloads.
 *
 * Receives Slack interactive payloads (approve/reject button clicks),
 * verifies the Slack HMAC-SHA256 signature, validates the approval token
 * against Postgres, resolves the approval, and (on approval) sends an SQS
 * message to resume the pipeline at the Execute stage.
 *
 * @see D-01 Slack approval flow
 * @see D-04 Webhook handler validates and resumes pipeline
 * @see T-03-20 HMAC-SHA256 verification with timingSafeEqual
 * @see T-03-21 Replay protection with 5-minute timestamp window
 * @see T-03-22 Token validation against Postgres
 * @see T-03-23 SQS message only sent on valid approval
 * @see T-03-24 Generic error responses (no internal state leaked)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { Pool } from 'pg';
import { PipelineStage, NEXT_STAGE, type StageMessage } from '../pipeline/types.js';
import { getApprovalByToken, resolveApproval, getPipelineRun } from '../postgres-client.js';
import { track, flush } from '../analytics.js';

// --- Error -------------------------------------------------------------------

/**
 * Error thrown by webhook handler operations.
 * Includes the operation name for structured logging.
 */
export class WebhookHandlerError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
  ) {
    super(message);
    this.name = 'WebhookHandlerError';
  }
}

// --- Secrets Manager cache ---------------------------------------------------

let cachedSigningSecret: string | undefined;

/**
 * Retrieves the Slack signing secret from AWS Secrets Manager.
 * Caches the value for the Lambda execution lifetime (warm starts).
 */
async function getSigningSecret(): Promise<string> {
  if (cachedSigningSecret) return cachedSigningSecret;
  const secretArn = process.env.SLACK_SIGNING_SECRET_ARN;
  if (!secretArn) throw new Error('SLACK_SIGNING_SECRET_ARN not set');
  const client = new SecretsManagerClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Signing secret is empty');
  cachedSigningSecret = response.SecretString;
  return cachedSigningSecret;
}

// --- Signature verification --------------------------------------------------

/**
 * Verifies Slack request signature using HMAC-SHA256.
 * Per Slack docs: v0={HMAC-SHA256 of v0:timestamp:body using signing secret}
 * Rejects requests older than 5 minutes (replay protection).
 *
 * @param signingSecret - Slack app signing secret
 * @param timestamp - X-Slack-Request-Timestamp header value
 * @param body - Raw request body
 * @param signature - X-Slack-Signature header value
 * @returns true if signature is valid and timestamp is fresh
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const fiveMinutes = 5 * 60;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) {
    return false;
  }
  const sigBaseString = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${createHmac('sha256', signingSecret)
    .update(sigBaseString)
    .digest('hex')}`;
  const a = Buffer.from(mySignature);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Handler -----------------------------------------------------------------

/**
 * Processes a Slack interactive payload.
 *
 * Steps:
 * 1. Verify Slack signature (HMAC-SHA256)
 * 2. Parse URL-encoded body, extract payload JSON
 * 3. Extract action_id and approval token from payload
 * 4. Validate token against Postgres
 * 5. Resolve approval (approved/rejected)
 * 6. On approval: construct StageMessage and send to SQS
 * 7. Return 200
 *
 * @param event - API Gateway proxy event
 * @param pool - Postgres connection pool
 * @param sqsClient - Optional SQS client (injected for testing)
 * @returns API Gateway proxy result
 */
export async function handleSlackAction(
  event: APIGatewayProxyEvent,
  pool: Pool,
  sqsClient?: SQSClient,
): Promise<APIGatewayProxyResult> {
  const timestamp = event.headers['x-slack-request-timestamp'] ?? '';
  const slackSignature = event.headers['x-slack-signature'] ?? '';

  // Decode base64 body first so signature verification uses the same bytes Slack signed
  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : (event.body ?? '');

  // Step 1: Verify signature against the decoded body
  const signingSecret = await getSigningSecret();
  if (!verifySlackSignature(signingSecret, timestamp, rawBody, slackSignature)) {
    console.log(JSON.stringify({ level: 'warn', message: 'Invalid Slack signature' }));
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // Step 2: Parse payload (Slack sends application/x-www-form-urlencoded)
  const params = new URLSearchParams(rawBody);
  const payloadJson = params.get('payload');
  if (!payloadJson) {
    return { statusCode: 400, body: 'Missing payload' };
  }

  let payload: {
    type: string;
    user: { id: string; username: string };
    actions: Array<{ action_id: string; value: string }>;
  };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { statusCode: 400, body: 'Invalid payload JSON' };
  }

  // Step 3: Extract action
  const action = payload.actions?.[0];
  const KNOWN_ACTIONS = [
    'pipeline_approve', 'pipeline_reject',
    'escalation_approve', 'escalation_reject',
  ];
  if (!action || !KNOWN_ACTIONS.includes(action.action_id)) {
    return { statusCode: 400, body: 'Unknown action' };
  }

  const token = action.value;
  const isApproval = action.action_id === 'pipeline_approve' || action.action_id === 'escalation_approve';
  const resolvedBy = payload.user?.username ?? 'unknown';

  // Step 4: Validate token
  const approval = await getApprovalByToken(pool, token);
  if (!approval) {
    console.log(JSON.stringify({ level: 'warn', message: 'Approval token not found', token }));
    return { statusCode: 400, body: 'Invalid or expired approval token' };
  }
  if (approval.status !== 'pending') {
    console.log(JSON.stringify({ level: 'info', message: 'Approval already resolved', token, status: approval.status }));
    return { statusCode: 200, body: 'Already processed' };
  }

  // Step 5: Resolve approval (returns false if already resolved by concurrent request)
  const wasResolved = await resolveApproval(pool, token, isApproval ? 'approved' : 'rejected', resolvedBy);
  if (!wasResolved) {
    console.log(JSON.stringify({ level: 'info', message: 'Approval already resolved by concurrent request', token }));
    return { statusCode: 200, body: 'Already processed' };
  }

  track(isApproval ? 'approval_approved' : 'approval_rejected', {
    runId: approval.pipelineRunId,
    token,
    resolvedBy,
  });

  // Step 6: On approval, resume pipeline via SQS
  if (isApproval) {
    const pipelineRun = await getPipelineRun(pool, approval.pipelineRunId);
    if (!pipelineRun) {
      throw new WebhookHandlerError(
        `Pipeline run ${approval.pipelineRunId} not found`,
        'handleSlackAction',
      );
    }

    const stageQueueUrl = process.env.STAGE_QUEUE_URL;
    if (!stageQueueUrl) throw new Error('STAGE_QUEUE_URL not set');

    // Determine resume stage based on approval type:
    // - risk_escalation: resume at current stage (re-enter auto-decide)
    // - plan_approval: advance to next stage after Approve
    let nextStage: PipelineStage;
    if (approval.approvalType === 'risk_escalation') {
      // Escalation: resume at the current stage the pipeline was executing
      nextStage = (pipelineRun.currentStage as PipelineStage) ?? PipelineStage.Execute;
    } else {
      // Plan approval: advance to next stage
      const ns = NEXT_STAGE[PipelineStage.Approve];
      if (!ns) throw new Error('No stage after Approve');
      nextStage = ns;
    }

    // Build StageMessage for the resume stage
    // Read from dedicated PipelineRun columns, not the JSON config blob
    const nextMsg: StageMessage = {
      runId: approval.pipelineRunId,
      projectId: pipelineRun.projectId,
      repoUrl: pipelineRun.repoUrl,
      branch: pipelineRun.branch,
      stage: nextStage,
      context: {
        featureDescription: pipelineRun.featureDescription,
        phaseNumber: pipelineRun.phaseCurrent,
        phaseTotal: pipelineRun.phaseTotal,
        previousArtifacts: [],
        featureBranch: pipelineRun.featureBranch,
        linearParentTicketId: pipelineRun.linearParentTicketId,
      },
    };

    const sqs = sqsClient ?? new SQSClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
    await sqs.send(new SendMessageCommand({
      QueueUrl: stageQueueUrl,
      MessageBody: JSON.stringify(nextMsg),
    }));

    // Update pipeline status back to 'running'
    await pool.query(
      `UPDATE pipeline_runs SET status = 'running', current_stage = $1 WHERE id = $2`,
      [nextStage, approval.pipelineRunId],
    );

    console.log(JSON.stringify({
      level: 'info',
      message: 'Pipeline resumed after approval',
      runId: approval.pipelineRunId,
      nextStage,
    }));
  } else {
    // Rejection: mark pipeline as rejected
    await pool.query(
      `UPDATE pipeline_runs SET status = 'rejected' WHERE id = $1`,
      [approval.pipelineRunId],
    );

    console.log(JSON.stringify({
      level: 'info',
      message: 'Pipeline rejected',
      runId: approval.pipelineRunId,
    }));
  }

  await flush();
  return { statusCode: 200, body: '' };
}

// --- Lambda entry point ------------------------------------------------------

/** Module-scoped pool reused across warm Lambda invocations. */
let _pool: Pool | undefined;

/**
 * Returns a cached Postgres pool, creating one on first call (cold start).
 * The pool is reused across warm invocations to avoid exhausting RDS
 * connections under burst load.
 *
 * If DATABASE_URL is set, uses it directly. Otherwise constructs the
 * connection string from DB_SECRET_ARN via Secrets Manager (Lambda path).
 */
async function getPool(): Promise<Pool> {
  if (!_pool) {
    let databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      const secretArn = process.env.DB_SECRET_ARN;
      if (!secretArn) throw new Error('Neither DATABASE_URL nor DB_SECRET_ARN is set');
      const client = new SecretsManagerClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
      const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      if (!resp.SecretString) throw new Error('DB secret is empty');
      const creds = JSON.parse(resp.SecretString) as {
        username: string; password: string; host: string; port: number; dbname: string;
      };
      databaseUrl = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${creds.host}:${creds.port}/${creds.dbname}`;
    }
    const { createDbPool } = await import('../postgres-client.js');
    _pool = createDbPool(databaseUrl);
  }
  return _pool;
}

/**
 * Lambda handler entry point for Slack interactive webhooks.
 *
 * Uses a module-scoped Postgres pool that is reused across warm invocations.
 * The pool is NOT ended after each request -- this is intentional for
 * connection reuse in Lambda's execution model.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const pool = await getPool();
  return handleSlackAction(event, pool);
};

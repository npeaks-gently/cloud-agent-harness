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
  return timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature),
  );
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
  const body = event.body ?? '';
  const timestamp = event.headers['x-slack-request-timestamp'] ?? '';
  const slackSignature = event.headers['x-slack-signature'] ?? '';

  // Step 1: Verify signature
  const signingSecret = await getSigningSecret();
  if (!verifySlackSignature(signingSecret, timestamp, body, slackSignature)) {
    console.log(JSON.stringify({ level: 'warn', message: 'Invalid Slack signature' }));
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // Step 2: Parse payload (Slack sends application/x-www-form-urlencoded)
  // Handle base64-encoded body from API Gateway v2
  const rawBody = event.isBase64Encoded
    ? Buffer.from(body, 'base64').toString('utf-8')
    : body;
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
  if (!action || !['pipeline_approve', 'pipeline_reject'].includes(action.action_id)) {
    return { statusCode: 400, body: 'Unknown action' };
  }

  const token = action.value;
  const isApproval = action.action_id === 'pipeline_approve';
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

  // Step 5: Resolve approval
  await resolveApproval(pool, token, isApproval ? 'approved' : 'rejected', resolvedBy);

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

    const nextStage = NEXT_STAGE[PipelineStage.Approve];
    if (!nextStage) throw new Error('No stage after Approve');

    // Build StageMessage for the next stage (Execute)
    // Pipeline run config stores repoUrl, branch, featureDescription, etc.
    const config = pipelineRun.config as Record<string, unknown>;
    const nextMsg: StageMessage = {
      runId: approval.pipelineRunId,
      projectId: pipelineRun.projectId,
      repoUrl: (config.repoUrl as string) ?? '',
      branch: (config.branch as string) ?? '',
      stage: nextStage,
      context: {
        featureDescription: (config.featureDescription as string) ?? '',
        phaseNumber: pipelineRun.phaseCurrent,
        phaseTotal: pipelineRun.phaseTotal,
        previousArtifacts: [],
        featureBranch: config.featureBranch as string | undefined,
        linearParentTicketId: config.linearParentTicketId as string | undefined,
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

/**
 * Lambda handler entry point for Slack interactive webhooks.
 *
 * Creates a Postgres pool at cold start (imported from postgres-client).
 * The pool is reused across warm invocations.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Pool creation is deferred to the first invocation
  // In production, DATABASE_URL is set from Secrets Manager via CDK
  const { createDbPool } = await import('../postgres-client.js');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { statusCode: 500, body: 'Server configuration error' };
  }
  const pool = createDbPool(databaseUrl);
  try {
    return await handleSlackAction(event, pool);
  } finally {
    await pool.end();
  }
};

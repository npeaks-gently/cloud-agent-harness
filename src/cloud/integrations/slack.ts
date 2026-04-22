/**
 * Slack Web API wrapper for pipeline approval messages.
 *
 * Sends Block Kit approval messages with approve/reject buttons
 * to a configured Slack channel. Bot token is fetched from
 * Secrets Manager and cached at Lambda cold start.
 *
 * @see D-04 Block Kit approve/reject buttons
 */

import { WebClient } from '@slack/web-api';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by Slack integration operations.
 * Includes the operation that failed and optionally the target channel.
 */
export class SlackClientError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly channel?: string,
  ) {
    super(message);
    this.name = 'SlackClientError';
  }
}

// ─── Secrets ────────────────────────────────────────────────────────────────

/** Cached Slack bot token resolved from Secrets Manager at Lambda cold start. */
let cachedBotToken: string | undefined;

/**
 * Fetches the Slack bot token from Secrets Manager and caches it.
 *
 * The secret ARN is provided via SLACK_BOT_TOKEN_SECRET_ARN env var
 * (set by the pipeline CDK construct). The value is cached in module
 * scope so subsequent invocations reuse it within the same Lambda
 * execution context.
 *
 * @returns The resolved bot token string
 * @throws Error if SLACK_BOT_TOKEN_SECRET_ARN is not set or secret fetch fails
 */
export async function getSlackBotToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken;
  const secretArn = process.env.SLACK_BOT_TOKEN_SECRET_ARN;
  if (!secretArn) throw new Error('SLACK_BOT_TOKEN_SECRET_ARN not set');
  const smClient = new SecretsManagerClient({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  });
  const response = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) {
    throw new Error('Secrets Manager returned empty SecretString');
  }
  cachedBotToken = response.SecretString;
  return cachedBotToken;
}

/**
 * Resets the cached bot token. Intended for testing only.
 * @internal
 */
export function _resetTokenCache(): void {
  cachedBotToken = undefined;
}

// ─── Approval Message ───────────────────────────────────────────────────────

/**
 * Sends a Block Kit approval message with approve/reject buttons to a Slack channel.
 *
 * The message includes a header, plan summary section, and action buttons
 * with unique action IDs for the webhook Lambda to match on callback (D-04).
 *
 * @param channel - Slack channel ID to post to
 * @param runId - Pipeline run identifier
 * @param projectId - Project identifier
 * @param approvalToken - UUID token stored in Postgres approvals table
 * @param planSummary - Human-readable plan summary for the approval message
 * @returns Slack message timestamp (ts) or empty string if not available
 * @throws {SlackClientError} When the Slack API call fails
 */
export async function sendApprovalMessage(
  channel: string,
  runId: string,
  projectId: string,
  approvalToken: string,
  planSummary: string,
): Promise<string> {
  const token = await getSlackBotToken();
  const client = new WebClient(token);

  try {
    const result = await client.chat.postMessage({
      channel,
      text: `Pipeline approval requested for run ${runId}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Pipeline Plan Approval',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Run:* \`${runId}\`\n*Project:* \`${projectId}\`\n\n${planSummary}`,
          },
        },
        {
          type: 'actions',
          block_id: `approval_${approvalToken}`,
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Approve',
              },
              style: 'primary',
              action_id: 'pipeline_approve',
              value: approvalToken,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Reject',
              },
              style: 'danger',
              action_id: 'pipeline_reject',
              value: approvalToken,
            },
          ],
        },
      ],
    });

    console.log(JSON.stringify({
      level: 'info',
      message: 'Slack approval message sent',
      runId,
      channel,
    }));

    return result.ts ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SlackClientError(
      `Failed to send approval message: ${message}`,
      'sendApprovalMessage',
      channel,
    );
  }
}

// ─── Escalation Message ────────────────────────────────────────────────────

/**
 * Sends a risk escalation message to Slack with approve/reject buttons.
 *
 * Follows the same pattern as sendApprovalMessage but with escalation-specific
 * action_ids and messaging. Reuses the same Slack channel (D-05).
 *
 * @param channel - Slack channel ID
 * @param runId - Pipeline run UUID
 * @param projectId - Project identifier
 * @param approvalToken - UUID token for approval resolution
 * @param decisionSummary - Human-readable summary of the decision
 * @param riskReason - Why this decision was classified as high-risk
 * @returns Slack message timestamp
 * @throws {SlackClientError} When the Slack API call fails
 */
export async function sendEscalationMessage(
  channel: string,
  runId: string,
  projectId: string,
  approvalToken: string,
  decisionSummary: string,
  riskReason: string,
): Promise<string> {
  const token = await getSlackBotToken();
  const client = new WebClient(token);

  try {
    const result = await client.chat.postMessage({
      channel,
      text: `Risk escalation for run ${runId}: ${riskReason}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Risk Escalation' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Run:* \`${runId}\`\n*Project:* \`${projectId}\`\n*Risk:* ${riskReason}\n\n${decisionSummary}`,
          },
        },
        {
          type: 'actions',
          block_id: `escalation_${approvalToken}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve Decision' },
              style: 'primary',
              action_id: 'escalation_approve',
              value: approvalToken,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject Decision' },
              style: 'danger',
              action_id: 'escalation_reject',
              value: approvalToken,
            },
          ],
        },
      ],
    });

    console.log(JSON.stringify({
      level: 'info',
      message: 'Slack escalation message sent',
      runId,
      channel,
      riskReason,
    }));

    return result.ts ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SlackClientError(
      `Failed to send escalation message: ${message}`,
      'sendEscalationMessage',
      channel,
    );
  }
}

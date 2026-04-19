/**
 * Linear SDK wrapper for ticket lifecycle management.
 *
 * Wraps @linear/sdk to create parent tickets, sub-tickets,
 * update status, and attach PR URLs. API key is fetched from
 * Secrets Manager and cached at Lambda cold start.
 *
 * @see D-09 Pipeline-created tickets at intake
 * @see D-10 Sub-ticket per phase with parentId linking
 * @see D-11 PR URL linked to parent ticket on completion
 */

import { LinearClient } from '@linear/sdk';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by Linear integration operations.
 * Includes the operation that failed and optionally the issue ID.
 */
export class LinearClientError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly issueId?: string,
  ) {
    super(message);
    this.name = 'LinearClientError';
  }
}

// ─── Secrets ────────────────────────────────────────────────────────────────

/** Cached Linear API key resolved from Secrets Manager at Lambda cold start. */
let cachedLinearApiKey: string | undefined;

/**
 * Fetches the Linear API key from Secrets Manager and caches it.
 *
 * The secret ARN is provided via LINEAR_API_KEY_SECRET_ARN env var
 * (set by the pipeline CDK construct). The value is cached in module
 * scope so subsequent invocations reuse it within the same Lambda
 * execution context.
 *
 * @returns The resolved API key string
 * @throws Error if LINEAR_API_KEY_SECRET_ARN is not set or secret fetch fails
 */
export async function getLinearApiKey(): Promise<string> {
  if (cachedLinearApiKey) return cachedLinearApiKey;
  const secretArn = process.env.LINEAR_API_KEY_SECRET_ARN;
  if (!secretArn) throw new Error('LINEAR_API_KEY_SECRET_ARN not set');
  const smClient = new SecretsManagerClient({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  });
  const response = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) {
    throw new Error('Secrets Manager returned empty SecretString');
  }
  cachedLinearApiKey = response.SecretString;
  return cachedLinearApiKey;
}

/**
 * Resets the cached Linear API key. Intended for testing only.
 * @internal
 */
export function _resetTokenCache(): void {
  cachedLinearApiKey = undefined;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Cached Linear config parsed once at cold start. */
let cachedLinearConfig: { teamId: string; states: Record<string, string> } | undefined;

/**
 * Linear team and state configuration read from environment variables.
 * Parsed once and cached for the Lambda execution lifetime.
 *
 * LINEAR_TEAM_ID: The Linear team ID for issue creation.
 * LINEAR_STATE_MAP: JSON string mapping status keys to Linear state UUIDs.
 * Expected shape: { "todo": "state-uuid", "in_progress": "state-uuid", "done": "state-uuid" }
 *
 * @throws {LinearClientError} When LINEAR_TEAM_ID is not set or LINEAR_STATE_MAP is invalid JSON
 */
function getLinearConfig(): { teamId: string; states: Record<string, string> } {
  if (cachedLinearConfig) return cachedLinearConfig;

  const teamId = process.env.LINEAR_TEAM_ID;
  if (!teamId) throw new LinearClientError('LINEAR_TEAM_ID not set', 'getLinearConfig');

  let states: Record<string, string> = {};
  const raw = process.env.LINEAR_STATE_MAP;
  if (raw) {
    try {
      states = JSON.parse(raw) as Record<string, string>;
    } catch {
      throw new LinearClientError(
        'LINEAR_STATE_MAP contains invalid JSON',
        'getLinearConfig',
      );
    }
  }

  cachedLinearConfig = { teamId, states };
  return cachedLinearConfig;
}

// ─── Ticket CRUD ────────────────────────────────────────────────────────────

/**
 * Creates a parent Linear ticket for a pipeline run.
 *
 * The ticket title is prefixed with [CAH] and includes the feature
 * description. The description includes the pipeline run ID for
 * traceability (D-09).
 *
 * @param runId - Pipeline run identifier
 * @param featureDescription - Human-readable feature description
 * @returns Object with the ticket ID and human-readable identifier
 * @throws {LinearClientError} When the Linear API call fails
 */
export async function createParentTicket(
  runId: string,
  featureDescription: string,
): Promise<{ ticketId: string; identifier: string }> {
  const apiKey = await getLinearApiKey();
  const client = new LinearClient({ apiKey });
  const config = getLinearConfig();

  try {
    const safeDescription = featureDescription.slice(0, 200).trim();
    const issuePayload = await client.createIssue({
      teamId: config.teamId,
      title: `[CAH] ${safeDescription}`,
      description: `Pipeline run: ${runId}\n\nFeature: ${featureDescription}`,
    });

    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error('Linear createIssue returned no issue');
    }

    console.log(JSON.stringify({
      level: 'info',
      message: 'Linear parent ticket created',
      ticketId: issue.id,
      identifier: issue.identifier,
      runId,
    }));

    return { ticketId: issue.id, identifier: issue.identifier };
  } catch (err) {
    if (err instanceof LinearClientError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new LinearClientError(
      `Failed to create parent ticket: ${message}`,
      'createParentTicket',
    );
  }
}

/**
 * Creates a sub-ticket linked to a parent ticket for a pipeline phase.
 *
 * The sub-ticket is linked via Linear's parentId field on issue creation,
 * so it appears as a child in the parent's sub-issue list (D-10).
 *
 * @param parentTicketId - ID of the parent Linear ticket
 * @param phaseNumber - Pipeline phase number
 * @param phaseName - Human-readable phase name
 * @returns Object with the sub-ticket ID and human-readable identifier
 * @throws {LinearClientError} When the Linear API call fails
 */
export async function createSubTicket(
  parentTicketId: string,
  phaseNumber: number,
  phaseName: string,
): Promise<{ ticketId: string; identifier: string }> {
  const apiKey = await getLinearApiKey();
  const client = new LinearClient({ apiKey });
  const config = getLinearConfig();

  try {
    const issuePayload = await client.createIssue({
      teamId: config.teamId,
      title: `Phase ${phaseNumber}: ${phaseName}`,
      parentId: parentTicketId,
    });

    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error('Linear createIssue returned no issue');
    }

    console.log(JSON.stringify({
      level: 'info',
      message: 'Linear sub-ticket created',
      ticketId: issue.id,
      identifier: issue.identifier,
      parentTicketId,
    }));

    return { ticketId: issue.id, identifier: issue.identifier };
  } catch (err) {
    if (err instanceof LinearClientError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new LinearClientError(
      `Failed to create sub-ticket: ${message}`,
      'createSubTicket',
      parentTicketId,
    );
  }
}

/**
 * Updates a Linear ticket's status using the state map.
 *
 * The statusKey maps to a Linear state UUID via the LINEAR_STATE_MAP
 * environment variable. Stage transitions update the active phase's
 * sub-ticket status (D-10).
 *
 * @param ticketId - ID of the Linear ticket to update
 * @param statusKey - Key into LINEAR_STATE_MAP (e.g., 'in_progress', 'done')
 * @throws {LinearClientError} When the Linear API call fails
 */
export async function updateTicketStatus(
  ticketId: string,
  statusKey: string,
): Promise<void> {
  const apiKey = await getLinearApiKey();
  const client = new LinearClient({ apiKey });
  const config = getLinearConfig();

  const stateId = config.states[statusKey];
  if (!stateId) {
    throw new LinearClientError(
      `Unknown status key: ${statusKey}. Available keys: ${Object.keys(config.states).join(', ')}`,
      'updateTicketStatus',
      ticketId,
    );
  }

  try {
    await client.updateIssue(ticketId, { stateId });

    console.log(JSON.stringify({
      level: 'info',
      message: 'Linear ticket status updated',
      ticketId,
      statusKey,
      stateId,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LinearClientError(
      `Failed to update ticket status: ${message}`,
      'updateTicketStatus',
      ticketId,
    );
  }
}

/**
 * Attaches a PR URL to a Linear ticket.
 *
 * Creates an attachment on the ticket with the PR URL so the team
 * can navigate from Linear to the pull request (D-11).
 *
 * @param ticketId - ID of the Linear ticket
 * @param prUrl - Full URL of the pull request
 * @throws {LinearClientError} When the Linear API call fails
 */
export async function attachPrUrl(
  ticketId: string,
  prUrl: string,
): Promise<void> {
  const apiKey = await getLinearApiKey();
  const client = new LinearClient({ apiKey });

  try {
    await client.createAttachment({
      issueId: ticketId,
      title: 'Pull Request',
      url: prUrl,
    });

    console.log(JSON.stringify({
      level: 'info',
      message: 'PR URL attached to Linear ticket',
      ticketId,
      prUrl,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LinearClientError(
      `Failed to attach PR URL: ${message}`,
      'attachPrUrl',
      ticketId,
    );
  }
}

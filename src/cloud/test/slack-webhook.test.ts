import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockCreateHmac,
  mockTimingSafeEqual,
  mockSqsSend,
  mockSecretsManagerSend,
  mockGetApprovalByToken,
  mockResolveApproval,
  mockGetPipelineRun,
  mockTrack,
  mockFlush,
  mockPoolQuery,
} = vi.hoisted(() => ({
  mockCreateHmac: vi.fn(),
  mockTimingSafeEqual: vi.fn(),
  mockSqsSend: vi.fn(),
  mockSecretsManagerSend: vi.fn(),
  mockGetApprovalByToken: vi.fn(),
  mockResolveApproval: vi.fn(),
  mockGetPipelineRun: vi.fn(),
  mockTrack: vi.fn(),
  mockFlush: vi.fn(),
  mockPoolQuery: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('node:crypto', () => {
  return {
    createHmac: mockCreateHmac,
    timingSafeEqual: mockTimingSafeEqual,
  };
});

vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: class MockSQSClient {
      config: Record<string, unknown>;
      send = mockSqsSend;

      constructor(config: Record<string, unknown>) {
        this.config = config;
      }
    },
    SendMessageCommand: class MockSendMessageCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

vi.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManagerClient: class MockSecretsManagerClient {
      send = mockSecretsManagerSend;

      constructor(_config: Record<string, unknown>) {}
    },
    GetSecretValueCommand: class MockGetSecretValueCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

vi.mock('../postgres-client.js', () => ({
  getApprovalByToken: mockGetApprovalByToken,
  resolveApproval: mockResolveApproval,
  getPipelineRun: mockGetPipelineRun,
}));

vi.mock('../analytics.js', () => ({
  track: mockTrack,
  flush: mockFlush,
}));

// --- Fixtures ----------------------------------------------------------------

const VALID_SIGNING_SECRET = 'test-signing-secret';
const VALID_TOKEN = 'approval-token-uuid';
const VALID_RUN_ID = 'run-123';
const STAGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/cah-dev-stages';

const MOCK_POOL = { query: mockPoolQuery } as unknown;

function buildSlackEvent(
  actionId: string,
  token: string,
  overrides?: {
    timestamp?: string;
    signature?: string;
    missingPayload?: boolean;
    invalidJson?: boolean;
  },
): {
  body: string;
  headers: Record<string, string>;
  isBase64Encoded: boolean;
  httpMethod: string;
  path: string;
  pathParameters: null;
  queryStringParameters: null;
  stageVariables: null;
  requestContext: Record<string, unknown>;
  resource: string;
  multiValueHeaders: Record<string, string[]>;
  multiValueQueryStringParameters: null;
} {
  const timestamp = overrides?.timestamp ?? String(Math.floor(Date.now() / 1000));

  let body: string;
  if (overrides?.missingPayload) {
    body = 'no_payload_here=true';
  } else if (overrides?.invalidJson) {
    body = `payload=${encodeURIComponent('not valid json {{')}`;
  } else {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U123', username: 'testuser' },
      actions: [{ action_id: actionId, value: token, block_id: `approval_${token}` }],
    });
    body = `payload=${encodeURIComponent(payload)}`;
  }

  const signature = overrides?.signature ?? 'v0=valid_computed_signature';

  return {
    body,
    headers: {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    isBase64Encoded: false,
    httpMethod: 'POST',
    path: '/slack/webhook',
    pathParameters: null,
    queryStringParameters: null,
    stageVariables: null,
    requestContext: {},
    resource: '/slack/webhook',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
  };
}

const MOCK_APPROVAL = {
  id: 'approval-id-1',
  pipelineRunId: VALID_RUN_ID,
  status: 'pending',
  slackChannel: 'C123',
  requestedAt: new Date('2026-01-01T00:00:00Z'),
};

const MOCK_PIPELINE_RUN = {
  id: VALID_RUN_ID,
  projectId: 'project-abc',
  status: 'paused',
  phaseCurrent: 1,
  phaseTotal: 3,
  config: {
    repoUrl: 'https://github.com/org/repo.git',
    branch: 'main',
    featureDescription: 'Add user auth',
    featureBranch: 'cah/run123/add-user-auth',
    linearParentTicketId: 'linear-ticket-789',
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

// --- Import under test (after mocks) ----------------------------------------

import { handleSlackAction, verifySlackSignature, WebhookHandlerError } from '../webhook/slack-handler.js';
import type { Pool } from 'pg';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SQSClient } from '@aws-sdk/client-sqs';

// --- Tests -------------------------------------------------------------------

describe('slack-webhook-handler', () => {
  let pool: Pool;
  let sqsClient: SQSClient;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSqsSend.mockReset();
    mockSecretsManagerSend.mockReset();
    mockGetApprovalByToken.mockReset();
    mockResolveApproval.mockReset();
    mockGetPipelineRun.mockReset();
    mockTrack.mockReset();
    mockFlush.mockReset();
    mockFlush.mockResolvedValue(undefined);
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockCreateHmac.mockReset();
    mockTimingSafeEqual.mockReset();

    pool = MOCK_POOL as Pool;
    sqsClient = new SQSClient({});

    // Set up env vars
    process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:slack-signing';
    process.env.STAGE_QUEUE_URL = STAGE_QUEUE_URL;

    // Default: Secrets Manager returns the signing secret
    mockSecretsManagerSend.mockResolvedValue({ SecretString: VALID_SIGNING_SECRET });

    // Default: crypto mocks that validate signatures
    const mockDigest = vi.fn().mockReturnValue('computed_hex');
    const mockUpdate = vi.fn().mockReturnValue({ digest: mockDigest });
    mockCreateHmac.mockReturnValue({ update: mockUpdate });
    mockTimingSafeEqual.mockReturnValue(true);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // Reset the cached signing secret between tests
    vi.resetModules();
  });

  // --- Signature verification tests -------------------------------------------

  describe('signature verification', () => {
    it('returns 401 when Slack signature is invalid', async () => {
      mockTimingSafeEqual.mockReturnValue(false);

      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(401);
      expect(result.body).toBe('Invalid signature');
    });

    it('returns 401 when timestamp is older than 5 minutes', async () => {
      // Timestamp 10 minutes ago
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN, {
        timestamp: oldTimestamp,
      }) as unknown as APIGatewayProxyEvent;

      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(401);
      expect(result.body).toBe('Invalid signature');
    });
  });

  // --- Payload parsing tests --------------------------------------------------

  describe('payload parsing', () => {
    it('returns 400 when payload is missing', async () => {
      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN, {
        missingPayload: true,
      }) as unknown as APIGatewayProxyEvent;

      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing payload');
    });

    it('returns 400 when payload JSON is invalid', async () => {
      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN, {
        invalidJson: true,
      }) as unknown as APIGatewayProxyEvent;

      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Invalid payload JSON');
    });

    it('returns 400 when action is unknown', async () => {
      const event = buildSlackEvent('unknown_action', VALID_TOKEN) as unknown as APIGatewayProxyEvent;

      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Unknown action');
    });
  });

  // --- Token validation tests -------------------------------------------------

  describe('token validation', () => {
    it('returns 400 when approval token not found in Postgres', async () => {
      mockGetApprovalByToken.mockResolvedValue(null);

      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Invalid or expired approval token');
      expect(mockGetApprovalByToken).toHaveBeenCalledWith(pool, VALID_TOKEN);
    });

    it('returns 200 when approval already resolved', async () => {
      mockGetApprovalByToken.mockResolvedValue({
        ...MOCK_APPROVAL,
        status: 'approved',
      });

      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Already processed');
    });
  });

  // --- Approval flow tests ----------------------------------------------------

  describe('approval flow', () => {
    it('resolves approval and sends SQS message on pipeline_approve', async () => {
      mockGetApprovalByToken.mockResolvedValue(MOCK_APPROVAL);
      mockResolveApproval.mockResolvedValue(undefined);
      mockGetPipelineRun.mockResolvedValue(MOCK_PIPELINE_RUN);
      mockSqsSend.mockResolvedValue({});

      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(200);

      // Verify resolveApproval called with 'approved'
      expect(mockResolveApproval).toHaveBeenCalledWith(
        pool,
        VALID_TOKEN,
        'approved',
        'testuser',
      );

      // Verify SQS message sent
      expect(mockSqsSend).toHaveBeenCalledOnce();
      const command = mockSqsSend.mock.calls[0][0];
      expect(command.input.QueueUrl).toBe(STAGE_QUEUE_URL);

      const sentBody = JSON.parse(command.input.MessageBody as string);
      expect(sentBody.runId).toBe(VALID_RUN_ID);
      expect(sentBody.stage).toBe('execute');
      expect(sentBody.projectId).toBe('project-abc');
      expect(sentBody.repoUrl).toBe('https://github.com/org/repo.git');
      expect(sentBody.context.featureBranch).toBe('cah/run123/add-user-auth');
      expect(sentBody.context.linearParentTicketId).toBe('linear-ticket-789');

      // Verify pipeline status updated to 'running'
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'running'"),
        ['execute', VALID_RUN_ID],
      );
    });

    it('resolves approval as rejected and marks pipeline failed on pipeline_reject', async () => {
      mockGetApprovalByToken.mockResolvedValue(MOCK_APPROVAL);
      mockResolveApproval.mockResolvedValue(undefined);

      const event = buildSlackEvent('pipeline_reject', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      const result = await handleSlackAction(event, pool, sqsClient);

      expect(result.statusCode).toBe(200);

      // Verify resolveApproval called with 'rejected'
      expect(mockResolveApproval).toHaveBeenCalledWith(
        pool,
        VALID_TOKEN,
        'rejected',
        'testuser',
      );

      // Verify SQS message NOT sent
      expect(mockSqsSend).not.toHaveBeenCalled();

      // Verify pipeline status updated to 'rejected'
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'rejected'"),
        [VALID_RUN_ID],
      );
    });
  });

  // --- Analytics tracking tests -----------------------------------------------

  describe('analytics tracking', () => {
    it('tracks approval_approved event on approve', async () => {
      mockGetApprovalByToken.mockResolvedValue(MOCK_APPROVAL);
      mockResolveApproval.mockResolvedValue(undefined);
      mockGetPipelineRun.mockResolvedValue(MOCK_PIPELINE_RUN);
      mockSqsSend.mockResolvedValue({});

      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      await handleSlackAction(event, pool, sqsClient);

      expect(mockTrack).toHaveBeenCalledWith('approval_approved', {
        runId: VALID_RUN_ID,
        token: VALID_TOKEN,
        resolvedBy: 'testuser',
      });
    });

    it('tracks approval_rejected event on reject', async () => {
      mockGetApprovalByToken.mockResolvedValue(MOCK_APPROVAL);
      mockResolveApproval.mockResolvedValue(undefined);

      const event = buildSlackEvent('pipeline_reject', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      await handleSlackAction(event, pool, sqsClient);

      expect(mockTrack).toHaveBeenCalledWith('approval_rejected', {
        runId: VALID_RUN_ID,
        token: VALID_TOKEN,
        resolvedBy: 'testuser',
      });
    });

    it('calls flush before returning', async () => {
      mockGetApprovalByToken.mockResolvedValue(MOCK_APPROVAL);
      mockResolveApproval.mockResolvedValue(undefined);
      mockGetPipelineRun.mockResolvedValue(MOCK_PIPELINE_RUN);
      mockSqsSend.mockResolvedValue({});

      const event = buildSlackEvent('pipeline_approve', VALID_TOKEN) as unknown as APIGatewayProxyEvent;
      await handleSlackAction(event, pool, sqsClient);

      expect(mockFlush).toHaveBeenCalledOnce();
    });
  });

  // --- verifySlackSignature unit tests ----------------------------------------

  describe('verifySlackSignature', () => {
    it('uses timingSafeEqual for constant-time comparison', () => {
      const now = String(Math.floor(Date.now() / 1000));
      verifySlackSignature('secret', now, 'body', 'v0=sig');

      expect(mockTimingSafeEqual).toHaveBeenCalledOnce();
    });

    it('uses createHmac with sha256 algorithm', () => {
      const now = String(Math.floor(Date.now() / 1000));
      verifySlackSignature('my-secret', now, 'body', 'v0=sig');

      expect(mockCreateHmac).toHaveBeenCalledWith('sha256', 'my-secret');
    });
  });

  // --- WebhookHandlerError tests ----------------------------------------------

  describe('WebhookHandlerError', () => {
    it('has correct name and operation properties', () => {
      const err = new WebhookHandlerError('test message', 'testOp');
      expect(err.name).toBe('WebhookHandlerError');
      expect(err.operation).toBe('testOp');
      expect(err.message).toBe('test message');
      expect(err).toBeInstanceOf(Error);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockPostMessage,
  mockSend,
} = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockSend: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('@slack/web-api', () => {
  return {
    WebClient: class MockWebClient {
      chat = { postMessage: mockPostMessage };
      constructor(_token: string) {}
    },
  };
});

vi.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManagerClient: class MockSecretsManagerClient {
      send = mockSend;
      constructor(_config: Record<string, unknown>) {}
    },
    GetSecretValueCommand: class MockGetSecretValueCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

// --- Import under test (after mocks) ----------------------------------------

import {
  sendApprovalMessage,
  getSlackBotToken,
  SlackClientError,
  _resetTokenCache,
} from '../integrations/slack.js';

// --- Fixtures ----------------------------------------------------------------

const MOCK_CHANNEL = 'C01ABCDEF';
const MOCK_RUN_ID = 'run-abc-123';
const MOCK_PROJECT_ID = 'project-abc';
const MOCK_APPROVAL_TOKEN = 'tok-uuid-456';
const MOCK_PLAN_SUMMARY = 'Add user authentication with JWT tokens';

// --- Tests -------------------------------------------------------------------

describe('slack integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockReset();
    mockSend.mockReset();
    _resetTokenCache();
    process.env.SLACK_BOT_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:slack-bot';
  });

  // --- sendApprovalMessage ---------------------------------------------------

  describe('sendApprovalMessage', () => {
    it('sends Block Kit message with approve/reject buttons', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
      mockPostMessage.mockResolvedValueOnce({ ts: '123.456' });

      await sendApprovalMessage(
        MOCK_CHANNEL,
        MOCK_RUN_ID,
        MOCK_PROJECT_ID,
        MOCK_APPROVAL_TOKEN,
        MOCK_PLAN_SUMMARY,
      );

      expect(mockPostMessage).toHaveBeenCalledOnce();
      const callArgs = mockPostMessage.mock.calls[0][0];
      expect(callArgs.channel).toBe(MOCK_CHANNEL);

      // Verify blocks structure
      const blocks = callArgs.blocks;
      expect(blocks).toHaveLength(3);

      // Header block
      expect(blocks[0].type).toBe('header');
      expect(blocks[0].text.text).toBe('Pipeline Plan Approval');

      // Section block
      expect(blocks[1].type).toBe('section');
      expect(blocks[1].text.type).toBe('mrkdwn');
      expect(blocks[1].text.text).toContain(MOCK_RUN_ID);
      expect(blocks[1].text.text).toContain(MOCK_PROJECT_ID);
      expect(blocks[1].text.text).toContain(MOCK_PLAN_SUMMARY);

      // Actions block with approve/reject buttons
      expect(blocks[2].type).toBe('actions');
      expect(blocks[2].block_id).toBe(`approval_${MOCK_APPROVAL_TOKEN}`);
      const elements = blocks[2].elements;
      expect(elements).toHaveLength(2);

      // Approve button
      expect(elements[0].action_id).toBe('pipeline_approve');
      expect(elements[0].value).toBe(MOCK_APPROVAL_TOKEN);
      expect(elements[0].style).toBe('primary');

      // Reject button
      expect(elements[1].action_id).toBe('pipeline_reject');
      expect(elements[1].value).toBe(MOCK_APPROVAL_TOKEN);
      expect(elements[1].style).toBe('danger');
    });

    it('returns message timestamp', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
      mockPostMessage.mockResolvedValueOnce({ ts: '123.456' });

      const result = await sendApprovalMessage(
        MOCK_CHANNEL,
        MOCK_RUN_ID,
        MOCK_PROJECT_ID,
        MOCK_APPROVAL_TOKEN,
        MOCK_PLAN_SUMMARY,
      );

      expect(result).toBe('123.456');
    });

    it('returns empty string when ts is undefined', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
      mockPostMessage.mockResolvedValueOnce({});

      const result = await sendApprovalMessage(
        MOCK_CHANNEL,
        MOCK_RUN_ID,
        MOCK_PROJECT_ID,
        MOCK_APPROVAL_TOKEN,
        MOCK_PLAN_SUMMARY,
      );

      expect(result).toBe('');
    });

    it('throws SlackClientError on API failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
      mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));

      try {
        await sendApprovalMessage(
          MOCK_CHANNEL,
          MOCK_RUN_ID,
          MOCK_PROJECT_ID,
          MOCK_APPROVAL_TOKEN,
          MOCK_PLAN_SUMMARY,
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SlackClientError);
        const slackErr = err as SlackClientError;
        expect(slackErr.operation).toBe('sendApprovalMessage');
        expect(slackErr.channel).toBe(MOCK_CHANNEL);
        expect(slackErr.message).toContain('channel_not_found');
      }
    });

    it('includes text fallback for notifications', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
      mockPostMessage.mockResolvedValueOnce({ ts: '123.456' });

      await sendApprovalMessage(
        MOCK_CHANNEL,
        MOCK_RUN_ID,
        MOCK_PROJECT_ID,
        MOCK_APPROVAL_TOKEN,
        MOCK_PLAN_SUMMARY,
      );

      const callArgs = mockPostMessage.mock.calls[0][0];
      expect(callArgs.text).toContain(`Pipeline approval requested for run ${MOCK_RUN_ID}`);
    });
  });

  // --- getSlackBotToken ------------------------------------------------------

  describe('getSlackBotToken', () => {
    it('caches token after first call', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-cached-token' });

      const first = await getSlackBotToken();
      const second = await getSlackBotToken();

      expect(first).toBe('xoxb-cached-token');
      expect(second).toBe('xoxb-cached-token');
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('throws if secret ARN env var not set', async () => {
      delete process.env.SLACK_BOT_TOKEN_SECRET_ARN;

      await expect(getSlackBotToken()).rejects.toThrow(
        'SLACK_BOT_TOKEN_SECRET_ARN not set',
      );
    });

    it('throws if Secrets Manager returns empty SecretString', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: undefined });

      await expect(getSlackBotToken()).rejects.toThrow(
        'Secrets Manager returned empty SecretString',
      );
    });
  });
});

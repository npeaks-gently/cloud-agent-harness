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
  sendEscalationMessage,
  SlackClientError,
  _resetTokenCache,
} from '../integrations/slack.js';

// --- Fixtures ----------------------------------------------------------------

const MOCK_CHANNEL = 'C01ABCDEF';
const MOCK_RUN_ID = 'run-abc-123';
const MOCK_PROJECT_ID = 'project-abc';
const MOCK_APPROVAL_TOKEN = 'tok-uuid-456';
const MOCK_DECISION_SUMMARY = 'Should we add a new external dependency for PDF generation?';
const MOCK_RISK_REASON = 'New external dependency addition affects supply chain security';

// --- Tests -------------------------------------------------------------------

describe('sendEscalationMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockReset();
    mockSend.mockReset();
    _resetTokenCache();
    process.env.SLACK_BOT_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:slack-bot';
  });

  it('sends Block Kit message with escalation action_ids', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
    mockPostMessage.mockResolvedValueOnce({ ts: '789.012' });

    await sendEscalationMessage(
      MOCK_CHANNEL,
      MOCK_RUN_ID,
      MOCK_PROJECT_ID,
      MOCK_APPROVAL_TOKEN,
      MOCK_DECISION_SUMMARY,
      MOCK_RISK_REASON,
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const callArgs = mockPostMessage.mock.calls[0][0];
    expect(callArgs.channel).toBe(MOCK_CHANNEL);

    // Verify blocks structure
    const blocks = callArgs.blocks;
    expect(blocks).toHaveLength(3);

    // Header block
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toBe('Risk Escalation');

    // Section block
    expect(blocks[1].type).toBe('section');
    expect(blocks[1].text.type).toBe('mrkdwn');
    expect(blocks[1].text.text).toContain(MOCK_RUN_ID);
    expect(blocks[1].text.text).toContain(MOCK_PROJECT_ID);

    // Actions block with escalation approve/reject buttons
    expect(blocks[2].type).toBe('actions');
    expect(blocks[2].block_id).toBe(`escalation_${MOCK_APPROVAL_TOKEN}`);
    const elements = blocks[2].elements;
    expect(elements).toHaveLength(2);

    // Approve button
    expect(elements[0].action_id).toBe('escalation_approve');
    expect(elements[0].value).toBe(MOCK_APPROVAL_TOKEN);
    expect(elements[0].style).toBe('primary');

    // Reject button
    expect(elements[1].action_id).toBe('escalation_reject');
    expect(elements[1].value).toBe(MOCK_APPROVAL_TOKEN);
    expect(elements[1].style).toBe('danger');
  });

  it('includes risk reason in message text', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
    mockPostMessage.mockResolvedValueOnce({ ts: '789.012' });

    await sendEscalationMessage(
      MOCK_CHANNEL,
      MOCK_RUN_ID,
      MOCK_PROJECT_ID,
      MOCK_APPROVAL_TOKEN,
      MOCK_DECISION_SUMMARY,
      MOCK_RISK_REASON,
    );

    const callArgs = mockPostMessage.mock.calls[0][0];
    expect(callArgs.text).toContain(MOCK_RISK_REASON);
    expect(callArgs.text).toContain(MOCK_RUN_ID);
  });

  it('returns message timestamp', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
    mockPostMessage.mockResolvedValueOnce({ ts: '789.012' });

    const result = await sendEscalationMessage(
      MOCK_CHANNEL,
      MOCK_RUN_ID,
      MOCK_PROJECT_ID,
      MOCK_APPROVAL_TOKEN,
      MOCK_DECISION_SUMMARY,
      MOCK_RISK_REASON,
    );

    expect(result).toBe('789.012');
  });

  it('throws SlackClientError on failure', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'xoxb-test-token' });
    mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));

    try {
      await sendEscalationMessage(
        MOCK_CHANNEL,
        MOCK_RUN_ID,
        MOCK_PROJECT_ID,
        MOCK_APPROVAL_TOKEN,
        MOCK_DECISION_SUMMARY,
        MOCK_RISK_REASON,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackClientError);
      const slackErr = err as SlackClientError;
      expect(slackErr.operation).toBe('sendEscalationMessage');
      expect(slackErr.channel).toBe(MOCK_CHANNEL);
      expect(slackErr.message).toContain('channel_not_found');
    }
  });
});

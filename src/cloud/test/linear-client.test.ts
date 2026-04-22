import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockCreateIssue,
  mockUpdateIssue,
  mockCreateAttachment,
  mockSend,
} = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
  mockUpdateIssue: vi.fn(),
  mockCreateAttachment: vi.fn(),
  mockSend: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('@linear/sdk', () => {
  return {
    LinearClient: class MockLinearClient {
      createIssue = mockCreateIssue;
      updateIssue = mockUpdateIssue;
      createAttachment = mockCreateAttachment;
      constructor(_opts: Record<string, unknown>) {}
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
  createParentTicket,
  createSubTicket,
  updateTicketStatus,
  attachPrUrl,
  getLinearApiKey,
  LinearClientError,
  _resetTokenCache,
} from '../integrations/linear.js';

// --- Fixtures ----------------------------------------------------------------

const MOCK_RUN_ID = 'run-abc-123';
const MOCK_FEATURE = 'Add user authentication';
const MOCK_TICKET_ID = 'issue-uuid-789';
const MOCK_IDENTIFIER = 'CAH-42';
const MOCK_PARENT_ID = 'parent-uuid-456';
const MOCK_PR_URL = 'https://github.com/org/repo/pull/42';

const STATE_MAP = JSON.stringify({
  todo: 'state-todo-uuid',
  in_progress: 'state-ip-uuid',
  done: 'state-done-uuid',
});

// --- Tests -------------------------------------------------------------------

describe('linear integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateIssue.mockReset();
    mockUpdateIssue.mockReset();
    mockCreateAttachment.mockReset();
    mockSend.mockReset();
    _resetTokenCache();
    process.env.LINEAR_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:linear-key';
    process.env.LINEAR_TEAM_ID = 'team-uuid-123';
    process.env.LINEAR_STATE_MAP = STATE_MAP;
  });

  // --- createParentTicket ----------------------------------------------------

  describe('createParentTicket', () => {
    it('creates issue with correct title and description', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateIssue.mockResolvedValueOnce({
        issue: Promise.resolve({
          id: MOCK_TICKET_ID,
          identifier: MOCK_IDENTIFIER,
        }),
      });

      await createParentTicket(MOCK_RUN_ID, MOCK_FEATURE);

      expect(mockCreateIssue).toHaveBeenCalledOnce();
      const args = mockCreateIssue.mock.calls[0][0];
      expect(args.teamId).toBe('team-uuid-123');
      expect(args.title).toContain('[CAH]');
      expect(args.title).toContain(MOCK_FEATURE);
      expect(args.description).toContain(MOCK_RUN_ID);
      expect(args.description).toContain(MOCK_FEATURE);
    });

    it('returns ticketId and identifier', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateIssue.mockResolvedValueOnce({
        issue: Promise.resolve({
          id: MOCK_TICKET_ID,
          identifier: MOCK_IDENTIFIER,
        }),
      });

      const result = await createParentTicket(MOCK_RUN_ID, MOCK_FEATURE);

      expect(result.ticketId).toBe(MOCK_TICKET_ID);
      expect(result.identifier).toBe(MOCK_IDENTIFIER);
    });

    it('throws LinearClientError on failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateIssue.mockRejectedValueOnce(new Error('Rate limited'));

      try {
        await createParentTicket(MOCK_RUN_ID, MOCK_FEATURE);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        const linErr = err as LinearClientError;
        expect(linErr.operation).toBe('createParentTicket');
        expect(linErr.message).toContain('Rate limited');
      }
    });
  });

  // --- createSubTicket -------------------------------------------------------

  describe('createSubTicket', () => {
    it('creates issue with parentId', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateIssue.mockResolvedValueOnce({
        issue: Promise.resolve({
          id: MOCK_TICKET_ID,
          identifier: MOCK_IDENTIFIER,
        }),
      });

      await createSubTicket(MOCK_PARENT_ID, 2, 'pipeline-orchestration');

      expect(mockCreateIssue).toHaveBeenCalledOnce();
      const args = mockCreateIssue.mock.calls[0][0];
      expect(args.teamId).toBe('team-uuid-123');
      expect(args.title).toBe('Phase 2: pipeline-orchestration');
      expect(args.parentId).toBe(MOCK_PARENT_ID);
    });

    it('returns ticketId and identifier', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateIssue.mockResolvedValueOnce({
        issue: Promise.resolve({
          id: MOCK_TICKET_ID,
          identifier: MOCK_IDENTIFIER,
        }),
      });

      const result = await createSubTicket(MOCK_PARENT_ID, 2, 'pipeline-orchestration');

      expect(result.ticketId).toBe(MOCK_TICKET_ID);
      expect(result.identifier).toBe(MOCK_IDENTIFIER);
    });

    it('throws LinearClientError on failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateIssue.mockRejectedValueOnce(new Error('Team not found'));

      try {
        await createSubTicket(MOCK_PARENT_ID, 2, 'pipeline-orchestration');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        const linErr = err as LinearClientError;
        expect(linErr.operation).toBe('createSubTicket');
        expect(linErr.issueId).toBe(MOCK_PARENT_ID);
      }
    });
  });

  // --- updateTicketStatus ----------------------------------------------------

  describe('updateTicketStatus', () => {
    it('calls updateIssue with stateId from state map', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockUpdateIssue.mockResolvedValueOnce({});

      await updateTicketStatus(MOCK_TICKET_ID, 'in_progress');

      expect(mockUpdateIssue).toHaveBeenCalledOnce();
      expect(mockUpdateIssue).toHaveBeenCalledWith(MOCK_TICKET_ID, {
        stateId: 'state-ip-uuid',
      });
    });

    it('throws LinearClientError for unknown status key', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });

      try {
        await updateTicketStatus(MOCK_TICKET_ID, 'nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        const linErr = err as LinearClientError;
        expect(linErr.operation).toBe('updateTicketStatus');
        expect(linErr.message).toContain('Unknown status key');
      }
    });

    it('throws LinearClientError on API failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockUpdateIssue.mockRejectedValueOnce(new Error('Forbidden'));

      try {
        await updateTicketStatus(MOCK_TICKET_ID, 'done');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        const linErr = err as LinearClientError;
        expect(linErr.operation).toBe('updateTicketStatus');
        expect(linErr.message).toContain('Forbidden');
      }
    });
  });

  // --- attachPrUrl -----------------------------------------------------------

  describe('attachPrUrl', () => {
    it('calls createAttachment with issue and PR URL', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateAttachment.mockResolvedValueOnce({});

      await attachPrUrl(MOCK_TICKET_ID, MOCK_PR_URL);

      expect(mockCreateAttachment).toHaveBeenCalledOnce();
      expect(mockCreateAttachment).toHaveBeenCalledWith({
        issueId: MOCK_TICKET_ID,
        title: 'Pull Request',
        url: MOCK_PR_URL,
      });
    });

    it('throws LinearClientError on failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_test-key' });
      mockCreateAttachment.mockRejectedValueOnce(new Error('Issue not found'));

      try {
        await attachPrUrl(MOCK_TICKET_ID, MOCK_PR_URL);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LinearClientError);
        const linErr = err as LinearClientError;
        expect(linErr.operation).toBe('attachPrUrl');
        expect(linErr.issueId).toBe(MOCK_TICKET_ID);
        expect(linErr.message).toContain('Issue not found');
      }
    });
  });

  // --- getLinearApiKey -------------------------------------------------------

  describe('getLinearApiKey', () => {
    it('caches token after first call', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'lin_cached-key' });

      const first = await getLinearApiKey();
      const second = await getLinearApiKey();

      expect(first).toBe('lin_cached-key');
      expect(second).toBe('lin_cached-key');
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('throws if secret ARN env var not set', async () => {
      delete process.env.LINEAR_API_KEY_SECRET_ARN;

      await expect(getLinearApiKey()).rejects.toThrow(
        'LINEAR_API_KEY_SECRET_ARN not set',
      );
    });

    it('throws if Secrets Manager returns empty SecretString', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: undefined });

      await expect(getLinearApiKey()).rejects.toThrow(
        'Secrets Manager returned empty SecretString',
      );
    });
  });
});

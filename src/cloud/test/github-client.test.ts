import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockGetRef,
  mockCreateRef,
  mockPullsCreate,
  mockSend,
} = vi.hoisted(() => ({
  mockGetRef: vi.fn(),
  mockCreateRef: vi.fn(),
  mockPullsCreate: vi.fn(),
  mockSend: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      rest = {
        git: {
          getRef: mockGetRef,
          createRef: mockCreateRef,
        },
        pulls: {
          create: mockPullsCreate,
        },
      };
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
  createFeatureBranch,
  createPullRequest,
  getGitHubToken,
  GitHubClientError,
  _resetTokenCache,
} from '../integrations/github.js';

// --- Fixtures ----------------------------------------------------------------

const MOCK_OWNER = 'test-org';
const MOCK_REPO = 'test-repo';
const MOCK_BRANCH = 'cah/run-abc/feature-auth';
const MOCK_BASE = 'main';
const MOCK_SHA = 'abc123def456';

// --- Tests -------------------------------------------------------------------

describe('github integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRef.mockReset();
    mockCreateRef.mockReset();
    mockPullsCreate.mockReset();
    mockSend.mockReset();
    _resetTokenCache();
    process.env.CAH_GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-token';
  });

  // --- createFeatureBranch ---------------------------------------------------

  describe('createFeatureBranch', () => {
    it('gets base SHA and creates ref', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'ghp_test-token' });
      mockGetRef.mockResolvedValueOnce({
        data: { object: { sha: MOCK_SHA } },
      });
      mockCreateRef.mockResolvedValueOnce({});

      await createFeatureBranch(MOCK_OWNER, MOCK_REPO, MOCK_BRANCH, MOCK_BASE);

      expect(mockGetRef).toHaveBeenCalledOnce();
      expect(mockGetRef).toHaveBeenCalledWith({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        ref: `heads/${MOCK_BASE}`,
      });

      expect(mockCreateRef).toHaveBeenCalledOnce();
      expect(mockCreateRef).toHaveBeenCalledWith({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        ref: `refs/heads/${MOCK_BRANCH}`,
        sha: MOCK_SHA,
      });
    });

    it('throws GitHubClientError on failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'ghp_test-token' });
      mockGetRef.mockRejectedValueOnce(new Error('Not Found'));

      try {
        await createFeatureBranch(MOCK_OWNER, MOCK_REPO, MOCK_BRANCH, MOCK_BASE);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubClientError);
        const ghErr = err as GitHubClientError;
        expect(ghErr.operation).toBe('createFeatureBranch');
        expect(ghErr.repo).toBe(`${MOCK_OWNER}/${MOCK_REPO}`);
        expect(ghErr.message).toContain('Not Found');
      }
    });
  });

  // --- createPullRequest -----------------------------------------------------

  describe('createPullRequest', () => {
    it('returns url and number', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'ghp_test-token' });
      mockPullsCreate.mockResolvedValueOnce({
        data: {
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          number: 42,
        },
      });

      const result = await createPullRequest(
        MOCK_OWNER,
        MOCK_REPO,
        MOCK_BRANCH,
        MOCK_BASE,
        'feat: add user auth',
        'Implements JWT authentication',
      );

      expect(result.url).toBe('https://github.com/test-org/test-repo/pull/42');
      expect(result.number).toBe(42);

      expect(mockPullsCreate).toHaveBeenCalledOnce();
      expect(mockPullsCreate).toHaveBeenCalledWith({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        title: 'feat: add user auth',
        body: 'Implements JWT authentication',
        head: MOCK_BRANCH,
        base: MOCK_BASE,
      });
    });

    it('throws GitHubClientError on failure', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'ghp_test-token' });
      mockPullsCreate.mockRejectedValueOnce(new Error('Validation Failed'));

      try {
        await createPullRequest(
          MOCK_OWNER,
          MOCK_REPO,
          MOCK_BRANCH,
          MOCK_BASE,
          'feat: test',
          'body',
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubClientError);
        const ghErr = err as GitHubClientError;
        expect(ghErr.operation).toBe('createPullRequest');
        expect(ghErr.repo).toBe(`${MOCK_OWNER}/${MOCK_REPO}`);
        expect(ghErr.message).toContain('Validation Failed');
      }
    });
  });

  // --- getGitHubToken --------------------------------------------------------

  describe('getGitHubToken', () => {
    it('caches token after first call', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: 'ghp_cached-token' });

      const first = await getGitHubToken();
      const second = await getGitHubToken();

      expect(first).toBe('ghp_cached-token');
      expect(second).toBe('ghp_cached-token');
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('throws if secret ARN env var not set', async () => {
      delete process.env.CAH_GITHUB_TOKEN_SECRET_ARN;

      await expect(getGitHubToken()).rejects.toThrow(
        'CAH_GITHUB_TOKEN_SECRET_ARN not set',
      );
    });

    it('throws if Secrets Manager returns empty SecretString', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: undefined });

      await expect(getGitHubToken()).rejects.toThrow(
        'Secrets Manager returned empty SecretString',
      );
    });
  });
});

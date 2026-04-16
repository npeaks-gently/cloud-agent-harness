import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SqsConsumer, SqsConsumerError } from '../sqs-consumer.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: class MockSQSClient {
      config: Record<string, unknown>;
      send = mockSend;

      constructor(config: Record<string, unknown>) {
        this.config = config;
      }
    },
    ReceiveMessageCommand: class MockReceiveMessageCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    DeleteMessageCommand: class MockDeleteMessageCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/cah-dev-jobs';

const VALID_MESSAGE_BODY = JSON.stringify({
  projectId: 'project-abc',
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'main',
  featureDescription: 'Add user authentication',
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SqsConsumer', () => {
  let consumer: SqsConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    consumer = new SqsConsumer({ queueUrl: QUEUE_URL });
  });

  // ─── Constructor defaults ─────────────────────────────────────────────

  it('defaults region to us-east-1 and waitTimeSeconds to 20', async () => {
    // Verify waitTimeSeconds default by checking the command sent
    mockSend.mockResolvedValueOnce({ Messages: undefined });

    await consumer.receiveMessage();

    const command = mockSend.mock.calls[0][0];
    expect(command.input.WaitTimeSeconds).toBe(20);
  });

  it('accepts custom region and waitTimeSeconds', async () => {
    const customConsumer = new SqsConsumer({
      queueUrl: QUEUE_URL,
      region: 'eu-west-1',
      waitTimeSeconds: 5,
    });

    mockSend.mockResolvedValueOnce({ Messages: undefined });
    await customConsumer.receiveMessage();

    const command = mockSend.mock.calls[0][0];
    expect(command.input.WaitTimeSeconds).toBe(5);
  });

  // ─── receiveMessage ───────────────────────────────────────────────────

  describe('receiveMessage', () => {
    it('returns null when no messages available', async () => {
      mockSend.mockResolvedValueOnce({ Messages: undefined });

      const result = await consumer.receiveMessage();

      expect(result).toBeNull();
    });

    it('returns null when Messages array is empty', async () => {
      mockSend.mockResolvedValueOnce({ Messages: [] });

      const result = await consumer.receiveMessage();

      expect(result).toBeNull();
    });

    it('parses valid PipelineJobMessage from message body', async () => {
      mockSend.mockResolvedValueOnce({
        Messages: [{
          MessageId: 'msg-1',
          Body: VALID_MESSAGE_BODY,
          ReceiptHandle: 'receipt-handle-abc',
        }],
      });

      const result = await consumer.receiveMessage();

      expect(result).not.toBeNull();
      expect(result!.message.projectId).toBe('project-abc');
      expect(result!.message.repoUrl).toBe('https://github.com/org/repo.git');
      expect(result!.message.branch).toBe('main');
      expect(result!.message.featureDescription).toBe('Add user authentication');
      expect(result!.receiptHandle).toBe('receipt-handle-abc');
    });

    it('throws SqsConsumerError when body is invalid JSON', async () => {
      mockSend.mockResolvedValueOnce({
        Messages: [{
          MessageId: 'msg-bad-json',
          Body: 'not valid json {{{',
          ReceiptHandle: 'receipt-handle-xyz',
        }],
      });

      try {
        await consumer.receiveMessage();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SqsConsumerError);
        const sqsErr = err as SqsConsumerError;
        expect(sqsErr.operation).toBe('receiveMessage');
        expect(sqsErr.messageId).toBe('msg-bad-json');
        expect(sqsErr.message).toContain('parse message body as JSON');
      }
    });

    it('throws SqsConsumerError when body fails type guard validation', async () => {
      mockSend.mockResolvedValueOnce({
        Messages: [{
          MessageId: 'msg-invalid-schema',
          Body: JSON.stringify({ projectId: 'abc' }), // missing required fields
          ReceiptHandle: 'receipt-handle-xyz',
        }],
      });

      try {
        await consumer.receiveMessage();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SqsConsumerError);
        const sqsErr = err as SqsConsumerError;
        expect(sqsErr.operation).toBe('receiveMessage');
        expect(sqsErr.messageId).toBe('msg-invalid-schema');
        expect(sqsErr.message).toContain('PipelineJobMessage schema');
      }
    });

    it('uses MaxNumberOfMessages: 1 in ReceiveMessageCommand', async () => {
      mockSend.mockResolvedValueOnce({ Messages: undefined });

      await consumer.receiveMessage();

      const command = mockSend.mock.calls[0][0];
      expect(command.input.MaxNumberOfMessages).toBe(1);
    });
  });

  // ─── deleteMessage ────────────────────────────────────────────────────

  describe('deleteMessage', () => {
    it('sends DeleteMessageCommand with correct receipt handle', async () => {
      mockSend.mockResolvedValueOnce({});

      await consumer.deleteMessage('receipt-handle-123');

      expect(mockSend).toHaveBeenCalledOnce();
      const command = mockSend.mock.calls[0][0];
      expect(command.input.QueueUrl).toBe(QUEUE_URL);
      expect(command.input.ReceiptHandle).toBe('receipt-handle-123');
    });

    it('throws SqsConsumerError on delete failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network error'));

      try {
        await consumer.deleteMessage('receipt-handle-fail');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SqsConsumerError);
        const sqsErr = err as SqsConsumerError;
        expect(sqsErr.operation).toBe('deleteMessage');
        expect(sqsErr.message).toContain('Network error');
      }
    });
  });
});

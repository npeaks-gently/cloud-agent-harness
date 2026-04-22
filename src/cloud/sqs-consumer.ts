/**
 * SQS message consumer for pipeline job intake.
 *
 * Receives messages from the pipeline job queue, validates them
 * against the PipelineJobMessage schema using a type guard (T-02-03),
 * and provides message deletion for acknowledgment.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import type { PipelineJobMessage } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_WAIT_TIME_SECONDS = 20;

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by SQS consumer operations.
 * Includes the operation that failed and optionally the message ID.
 */
export class SqsConsumerError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly messageId?: string,
  ) {
    super(message);
    this.name = 'SqsConsumerError';
  }
}

// ─── Type guard ─────────────────────────────────────────────────────────────

/**
 * Validates that a parsed JSON body conforms to the PipelineJobMessage schema.
 * Checks all required fields are present and correctly typed (T-02-03).
 */
function isPipelineJobMessage(body: unknown): body is PipelineJobMessage {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.repoUrl === 'string' &&
    typeof obj.branch === 'string' &&
    typeof obj.featureDescription === 'string'
  );
}

// ─── Consumer ───────────────────────────────────────────────────────────────

/**
 * Consumes messages from an SQS queue for pipeline job intake.
 *
 * Uses long polling (default 20s) to efficiently receive messages
 * and validates message payloads with a type guard before processing.
 *
 * @example
 * ```typescript
 * const consumer = new SqsConsumer({
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/cah-dev-jobs',
 * });
 *
 * const result = await consumer.receiveMessage();
 * if (result) {
 *   console.log(`Job for project: ${result.message.projectId}`);
 *   await consumer.deleteMessage(result.receiptHandle);
 * }
 * ```
 */
export class SqsConsumer {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly waitTimeSeconds: number;

  constructor(opts: {
    queueUrl: string;
    region?: string;
    waitTimeSeconds?: number;
  }) {
    this.client = new SQSClient({ region: opts.region ?? DEFAULT_REGION });
    this.queueUrl = opts.queueUrl;
    this.waitTimeSeconds = opts.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS;
  }

  /**
   * Receives a single message from the queue using long polling.
   *
   * @returns Parsed message with receipt handle, or null if no message available
   * @throws {SqsConsumerError} When message body is invalid JSON or fails type guard
   */
  async receiveMessage(): Promise<{
    message: PipelineJobMessage;
    receiptHandle: string;
  } | null> {
    let messages: Message[] | undefined;

    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: this.waitTimeSeconds,
        }),
      );
      messages = response.Messages;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      throw new SqsConsumerError(
        `Failed to receive message: ${errMessage}`,
        'receiveMessage',
      );
    }

    if (!messages || messages.length === 0) {
      return null;
    }

    const msg = messages[0];

    // Parse message body as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.Body ?? '');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      throw new SqsConsumerError(
        `Failed to parse message body as JSON: ${errMessage}`,
        'receiveMessage',
        msg.MessageId,
      );
    }

    // Validate against PipelineJobMessage schema
    if (!isPipelineJobMessage(parsed)) {
      throw new SqsConsumerError(
        `Message body does not match PipelineJobMessage schema: missing required fields (projectId, repoUrl, branch, featureDescription)`,
        'receiveMessage',
        msg.MessageId,
      );
    }

    const receiptHandle = msg.ReceiptHandle;
    if (!receiptHandle) {
      throw new SqsConsumerError(
        `Message ${msg.MessageId ?? '(no id)'} missing ReceiptHandle`,
        'receiveMessage',
        msg.MessageId,
      );
    }

    return {
      message: parsed,
      receiptHandle,
    };
  }

  /**
   * Deletes a message from the queue after successful processing.
   *
   * @param receiptHandle - Receipt handle from the received message
   */
  async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      throw new SqsConsumerError(
        `Failed to delete message: ${errMessage}`,
        'deleteMessage',
      );
    }
  }
}

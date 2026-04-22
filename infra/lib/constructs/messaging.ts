/**
 * SQS messaging construct for Cloud Agent Harness.
 *
 * Creates a job queue with a dead letter queue for pipeline task intake.
 * Visibility timeout set to 900s (15 min) to accommodate agent task execution.
 * Failed messages move to DLQ after 3 receive attempts.
 */
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

// --- Props -------------------------------------------------------------------

/** Properties for the CahMessaging construct. */
export interface CahMessagingProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
}

// --- Construct ---------------------------------------------------------------

/**
 * SQS queue with dead letter queue for pipeline job intake.
 *
 * Main queue: `{prefix}-jobs` with 15-minute visibility timeout.
 * DLQ: `{prefix}-jobs-dlq` with 14-day retention for failed message inspection.
 *
 * @example
 * const messaging = new CahMessaging(this, 'Messaging', { prefix: 'cah-dev' });
 * // messaging.queue and messaging.dlq are available for IAM/outputs
 */
export class CahMessaging extends Construct {
  /** The main job queue. */
  public readonly queue: sqs.Queue;
  /** The dead letter queue for failed messages. */
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: CahMessagingProps) {
    super(scope, id);

    // --- Dead Letter Queue -----------------------------------------------------

    this.dlq = new sqs.Queue(this, 'JobsDlq', {
      queueName: `${props.prefix}-jobs-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // --- Main Queue ------------------------------------------------------------

    this.queue = new sqs.Queue(this, 'JobsQueue', {
      queueName: `${props.prefix}-jobs`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });
  }
}

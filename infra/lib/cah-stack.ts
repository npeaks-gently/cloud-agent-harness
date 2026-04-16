/**
 * Main CDK stack for Cloud Agent Harness.
 *
 * Composes all infrastructure constructs into a single stack (per D-02):
 * - Networking: VPC with public + isolated subnets, no NAT
 * - Storage: S3 bucket for pipeline artifacts
 * - Database: RDS Postgres 16 with Secrets Manager credentials
 * - Messaging: SQS queue with DLQ for job intake
 * - IAM: Least-privilege agent user for Daytona access
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CahNetworking } from './constructs/networking.js';
import { CahStorage } from './constructs/storage.js';
import { CahDatabase } from './constructs/database.js';
import { CahMessaging } from './constructs/messaging.js';
import { CahIam } from './constructs/iam.js';
import { CahPipelineLambda } from './constructs/pipeline-lambda.js';
import { CahSlackWebhook } from './constructs/slack-webhook.js';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

// --- Constants ---------------------------------------------------------------

/** Resource name prefix for dev environment. */
const PREFIX = 'cah-dev';

// --- Stack -------------------------------------------------------------------

/**
 * Single CDK stack containing all Cloud Agent Harness AWS resources.
 *
 * @example
 * const app = new cdk.App();
 * new CahStack(app, 'CahStack', { env: { region: 'us-east-1' } });
 */
export class CahStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Networking ------------------------------------------------------------

    const networking = new CahNetworking(this, 'Networking', {
      prefix: PREFIX,
    });

    // --- Storage ---------------------------------------------------------------

    const storage = new CahStorage(this, 'Storage', {
      prefix: PREFIX,
    });

    // --- Database --------------------------------------------------------------

    const database = new CahDatabase(this, 'Database', {
      prefix: PREFIX,
      vpc: networking.vpc,
    });

    // --- Messaging -------------------------------------------------------------

    const messaging = new CahMessaging(this, 'Messaging', {
      prefix: PREFIX,
    });

    // --- IAM -------------------------------------------------------------------

    new CahIam(this, 'Iam', {
      prefix: PREFIX,
      bucketArn: storage.bucket.bucketArn,
      queueArn: messaging.queue.queueArn,
      secretArn: database.secret.secretArn,
    });

    // --- Pipeline --------------------------------------------------------------

    const anthropicKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'AnthropicKeySecret',
      `${PREFIX}-anthropic-api-key`,
    );

    const pipeline = new CahPipelineLambda(this, 'Pipeline', {
      prefix: PREFIX,
      vpc: networking.vpc,
      bucketArn: storage.bucket.bucketArn,
      jobQueue: messaging.queue,
      dbSecretArn: database.secret.secretArn,
      dbSecurityGroup: database.securityGroup,
      anthropicKeySecret,
    });

    // --- Slack Webhook ----------------------------------------------------------

    const slackSigningSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SlackSigningSecret',
      `${PREFIX}-slack-signing-secret`,
    );

    const slackBotToken = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SlackBotToken',
      `${PREFIX}-slack-bot-token`,
    );

    const slackWebhook = new CahSlackWebhook(this, 'SlackWebhook', {
      prefix: PREFIX,
      vpc: networking.vpc,
      stageQueueUrl: pipeline.stageQueue.queueUrl,
      stageQueueArn: pipeline.stageQueue.queueArn,
      dbSecretArn: database.secret.secretArn,
      dbSecurityGroup: database.securityGroup,
      slackSigningSecret,
      slackBotToken,
    });

    // --- Stack Outputs ---------------------------------------------------------

    new cdk.CfnOutput(this, 'BucketName', {
      value: storage.bucket.bucketName,
      description: 'S3 pipeline bucket name',
    });

    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: database.instance.dbInstanceEndpointAddress,
      description: 'RDS Postgres endpoint address',
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: messaging.queue.queueUrl,
      description: 'SQS job queue URL',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: database.secret.secretArn,
      description: 'Secrets Manager secret ARN for DB credentials',
    });

    new cdk.CfnOutput(this, 'StageQueueUrl', {
      value: pipeline.stageQueue.queueUrl,
      description: 'SQS stage queue URL for pipeline routing',
    });

    new cdk.CfnOutput(this, 'StageRouterFnArn', {
      value: pipeline.stageRouterFn.functionArn,
      description: 'Stage router Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'SlackWebhookUrl', {
      value: slackWebhook.api.apiEndpoint,
      description: 'Slack webhook API Gateway URL (configure in Slack app interactivity settings)',
    });
  }
}

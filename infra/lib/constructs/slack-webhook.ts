/**
 * CDK construct for Slack webhook Lambda behind API Gateway.
 *
 * Creates an HTTP API (v2) with a POST /slack/actions route that triggers
 * a Lambda function. The Lambda validates Slack signatures, processes
 * interactive payloads, and resumes the pipeline via SQS.
 *
 * @see D-02 Slack webhook Lambda behind API Gateway
 * @see D-03 Webhook Lambda re-enqueues next stage on approval
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'node:path';

// --- Props -------------------------------------------------------------------

/** Properties for the CahSlackWebhook construct. */
export interface CahSlackWebhookProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
  /** VPC for Lambda placement (RDS connectivity). */
  vpc: ec2.IVpc;
  /** URL of the stage queue for pipeline resume messages. */
  stageQueueUrl: string;
  /** ARN of the stage queue (for IAM policy). */
  stageQueueArn: string;
  /** ARN of the Secrets Manager secret containing DB credentials. */
  dbSecretArn: string;
  /** Security group of the RDS instance. */
  dbSecurityGroup: ec2.ISecurityGroup;
  /** Secrets Manager secret for Slack signing secret. */
  slackSigningSecret: secretsmanager.ISecret;
  /** Secrets Manager secret for Slack bot token (for message updates). */
  slackBotToken: secretsmanager.ISecret;
}

// --- Construct ---------------------------------------------------------------

/**
 * Slack webhook Lambda with API Gateway HTTP API for interactive payloads.
 *
 * Creates:
 * - HTTP API (v2) with POST /slack/actions route
 * - IAM role with least-privilege SQS SendMessage, Secrets Manager access (T-03-16)
 * - Lambda function in VPC private subnets with 10s timeout
 * - Security group ingress for RDS connectivity on port 5432
 *
 * Slack signing secret stored in Secrets Manager (T-03-17), not Lambda env var.
 * Signature verification implemented in the handler (Plan 05).
 *
 * @example
 * const webhook = new CahSlackWebhook(this, 'SlackWebhook', {
 *   prefix: 'cah-dev',
 *   vpc: networking.vpc,
 *   stageQueueUrl: pipeline.stageQueue.queueUrl,
 *   stageQueueArn: pipeline.stageQueue.queueArn,
 *   dbSecretArn: database.secret.secretArn,
 *   dbSecurityGroup: database.securityGroup,
 *   slackSigningSecret,
 *   slackBotToken,
 * });
 */
export class CahSlackWebhook extends Construct {
  /** The HTTP API for Slack webhook callbacks. */
  public readonly api: apigw.HttpApi;
  /** The webhook Lambda function. */
  public readonly webhookFn: lambda.Function;

  constructor(scope: Construct, id: string, props: CahSlackWebhookProps) {
    super(scope, id);

    // --- HTTP API --------------------------------------------------------------

    this.api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${props.prefix}-slack-webhook`,
    });

    // --- Lambda Security Group -------------------------------------------------

    const lambdaSg = new ec2.SecurityGroup(this, 'WebhookSg', {
      vpc: props.vpc,
      description: 'Security group for Slack webhook Lambda',
      allowAllOutbound: true,
    });

    props.dbSecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(5432),
      'Allow webhook Lambda to connect to RDS',
    );

    // --- IAM Role --------------------------------------------------------------

    const role = new iam.Role(this, 'WebhookRole', {
      roleName: `${props.prefix}-slack-webhook-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    });

    // SQS SendMessage -- stage queue only (least privilege, T-03-16)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SQSSendMessage',
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [props.stageQueueArn],
      }),
    );

    // Secrets Manager -- Slack signing secret, bot token, and DB credentials (T-03-16, T-03-17)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerAccess',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          props.slackSigningSecret.secretArn,
          props.slackBotToken.secretArn,
          props.dbSecretArn,
        ],
      }),
    );

    // --- Lambda Function -------------------------------------------------------

    this.webhookFn = new lambda.Function(this, 'WebhookFn', {
      functionName: `${props.prefix}-slack-webhook`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/slack-webhook')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      role,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      environment: {
        STAGE_QUEUE_URL: props.stageQueueUrl,
        SLACK_SIGNING_SECRET_ARN: props.slackSigningSecret.secretArn,
        DB_SECRET_ARN: props.dbSecretArn,
      },
    });

    // --- Route -----------------------------------------------------------------

    this.api.addRoutes({
      path: '/slack/actions',
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'SlackWebhookIntegration',
        this.webhookFn,
      ),
    });
  }
}

/**
 * CDK construct for pipeline Lambda functions.
 *
 * Creates a stage-router Lambda triggered by SQS messages from both the job
 * queue (intake) and an internal stage queue (inter-stage progression).
 * Lambda has IAM access to S3, SQS, Secrets Manager, and RDS via VPC placement.
 *
 * ANTHROPIC_API_KEY is NOT stored in Lambda env vars -- only the secret ARN
 * is provided so the handler fetches the key from Secrets Manager at cold start (T-02-18).
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Props -------------------------------------------------------------------

/** Properties for the CahPipelineLambda construct. */
export interface CahPipelineLambdaProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
  /** VPC for Lambda placement (RDS connectivity). */
  vpc: ec2.IVpc;
  /** ARN of the S3 pipeline bucket. */
  bucketArn: string;
  /** SQS job queue for pipeline intake messages. */
  jobQueue: sqs.IQueue;
  /** ARN of the Secrets Manager secret containing DB credentials. */
  dbSecretArn: string;
  /** Security group of the RDS instance (Lambda needs ingress). */
  dbSecurityGroup: ec2.ISecurityGroup;
  /** Secrets Manager secret containing the Anthropic API key. */
  anthropicKeySecret: secretsmanager.ISecret;
}

// --- Construct ---------------------------------------------------------------

/**
 * Pipeline Lambda with SQS event sources for stage routing.
 *
 * Creates:
 * - Internal stage queue (with DLQ) for inter-stage message passing
 * - IAM role with least-privilege S3, SQS, Secrets Manager access (T-02-17)
 * - Lambda function in VPC private subnets with 900s timeout
 * - SQS event sources from both job queue and stage queue
 * - Security group ingress for RDS connectivity on port 5432
 *
 * @example
 * const pipeline = new CahPipelineLambda(this, 'Pipeline', {
 *   prefix: 'cah-dev',
 *   vpc: networking.vpc,
 *   bucketArn: storage.bucket.bucketArn,
 *   jobQueue: messaging.queue,
 *   dbSecretArn: database.secret.secretArn,
 *   dbSecurityGroup: database.securityGroup,
 *   anthropicKeySecret,
 * });
 */
export class CahPipelineLambda extends Construct {
  /** The internal stage queue for inter-stage message passing. */
  public readonly stageQueue: sqs.Queue;
  /** The stage queue DLQ for failed messages. */
  public readonly stageDlq: sqs.Queue;
  /** The stage-router Lambda function. */
  public readonly stageRouterFn: lambda.Function;

  constructor(scope: Construct, id: string, props: CahPipelineLambdaProps) {
    super(scope, id);

    // --- Stage Queue (internal) ------------------------------------------------

    this.stageDlq = new sqs.Queue(this, 'StageDlq', {
      queueName: `${props.prefix}-stage-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.stageQueue = new sqs.Queue(this, 'StageQueue', {
      queueName: `${props.prefix}-stage`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.stageDlq,
        maxReceiveCount: 3,
      },
    });

    // --- Lambda Security Group -------------------------------------------------

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for pipeline stage-router Lambda',
      allowAllOutbound: true,
    });

    // Allow Lambda to connect to RDS on port 5432
    props.dbSecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(5432),
      'Allow pipeline Lambda to connect to RDS',
    );

    // --- IAM Role --------------------------------------------------------------

    const role = new iam.Role(this, 'StageRouterRole', {
      roleName: `${props.prefix}-stage-router-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    });

    // S3 access -- scoped to pipeline bucket (T-02-17)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BucketAccess',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [props.bucketArn, `${props.bucketArn}/*`],
      }),
    );

    // SQS access -- scoped to job queue and stage queue
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SQSAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:SendMessage',
        ],
        resources: [props.jobQueue.queueArn, this.stageQueue.queueArn],
      }),
    );

    // Secrets Manager -- DB credentials (T-02-17)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerDbAccess',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.dbSecretArn],
      }),
    );

    // Secrets Manager -- Anthropic API key (T-02-18)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerAnthropicAccess',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.anthropicKeySecret.secretArn],
      }),
    );

    // --- Lambda Function -------------------------------------------------------

    this.stageRouterFn = new lambda.Function(this, 'StageRouterFn', {
      functionName: `${props.prefix}-stage-router`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/stage-router')),
      timeout: cdk.Duration.seconds(900),
      memorySize: 512,
      role,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      environment: {
        STAGE_QUEUE_URL: this.stageQueue.queueUrl,
        NODE_OPTIONS: '--enable-source-maps',
        ANTHROPIC_API_KEY_SECRET_ARN: props.anthropicKeySecret.secretArn,
        DB_SECRET_ARN: props.dbSecretArn,
      },
    });

    // --- Event Sources ---------------------------------------------------------

    // Job queue triggers intake (batchSize: 1)
    this.stageRouterFn.addEventSource(
      new SqsEventSource(props.jobQueue, { batchSize: 1 }),
    );

    // Stage queue triggers stage routing (batchSize: 1)
    this.stageRouterFn.addEventSource(
      new SqsEventSource(this.stageQueue, { batchSize: 1 }),
    );
  }
}

/**
 * IAM construct for Cloud Agent Harness.
 *
 * Creates an IAM user and managed policy for Daytona agent execution.
 * Least-privilege access scoped to specific resource ARNs (T-01-02).
 * Access key stored in Secrets Manager for secure injection (T-01-07).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// --- Props -------------------------------------------------------------------

/** Properties for the CahIam construct. */
export interface CahIamProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
  /** ARN of the S3 pipeline bucket. */
  bucketArn: string;
  /** ARN of the SQS job queue. */
  queueArn: string;
  /** ARN of the Secrets Manager secret for DB credentials. */
  secretArn: string;
}

// --- Construct ---------------------------------------------------------------

/**
 * IAM user and policy for Daytona agent access to AWS resources.
 *
 * Policy grants:
 * - S3: GetObject, PutObject, ListBucket (scoped to pipeline bucket)
 * - SQS: ReceiveMessage, DeleteMessage, GetQueueAttributes (scoped to job queue)
 * - Secrets Manager: GetSecretValue (scoped to DB secret)
 *
 * Access key is created and stored in Secrets Manager as `{prefix}/agent-credentials`.
 *
 * @example
 * const iamConstruct = new CahIam(this, 'Iam', {
 *   prefix: 'cah-dev',
 *   bucketArn: storage.bucket.bucketArn,
 *   queueArn: messaging.queue.queueArn,
 *   secretArn: database.secret.secretArn,
 * });
 */
export class CahIam extends Construct {
  /** The IAM user for Daytona agent execution. */
  public readonly agentUser: iam.User;
  /** The managed policy attached to the agent user. */
  public readonly agentPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: CahIamProps) {
    super(scope, id);

    // --- Managed Policy --------------------------------------------------------

    this.agentPolicy = new iam.ManagedPolicy(this, 'AgentPolicy', {
      managedPolicyName: `${props.prefix}-agent-policy`,
      statements: [
        // S3 access -- scoped to pipeline bucket
        new iam.PolicyStatement({
          sid: 'S3BucketAccess',
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: [props.bucketArn, `${props.bucketArn}/*`],
        }),
        // SQS access -- scoped to job queue
        new iam.PolicyStatement({
          sid: 'SQSQueueAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
          ],
          resources: [props.queueArn],
        }),
        // Secrets Manager access -- scoped to DB credentials secret
        new iam.PolicyStatement({
          sid: 'SecretsManagerAccess',
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.secretArn],
        }),
      ],
    });

    // --- IAM User --------------------------------------------------------------

    this.agentUser = new iam.User(this, 'AgentUser', {
      userName: `${props.prefix}-agent`,
    });

    this.agentUser.addManagedPolicy(this.agentPolicy);

    // --- Access Key (stored in Secrets Manager) --------------------------------

    const accessKey = new iam.AccessKey(this, 'AgentAccessKey', {
      user: this.agentUser,
    });

    new secretsmanager.Secret(this, 'AgentCredentialsSecret', {
      secretName: `${props.prefix}/agent-credentials`,
      description: 'IAM access key credentials for Daytona agent user',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          accessKeyId: accessKey.accessKeyId,
          secretAccessKey: accessKey.secretAccessKey.unsafeUnwrap(),
        }),
      ),
    });
  }
}

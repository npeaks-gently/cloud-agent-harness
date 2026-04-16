/**
 * CDK assertion tests for the Cloud Agent Harness stack.
 *
 * Validates that the synthesized CloudFormation template contains all
 * required resources with correct configurations: VPC, S3, RDS, SQS,
 * IAM, and Secrets Manager.
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CahStack } from '../lib/cah-stack.js';

// --- Test Setup --------------------------------------------------------------

function createTemplate(): Template {
  const app = new cdk.App();
  const stack = new CahStack(app, 'TestStack', {
    env: { region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

// --- VPC Tests ---------------------------------------------------------------

describe('VPC', () => {
  it('creates a VPC with CIDR 10.0.0.0/16', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    });
  });

  it('does not create any NAT gateways', () => {
    const template = createTemplate();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('creates public subnets', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
  });
});

// --- S3 Tests ----------------------------------------------------------------

describe('S3 Bucket', () => {
  it('creates a bucket with BlockPublicAccess on all four flags', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('uses SSE-S3 encryption', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    });
  });

  it('has the correct bucket name', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'cah-dev-pipeline-bucket',
    });
  });
});

// --- RDS Tests ---------------------------------------------------------------

describe('RDS Postgres', () => {
  it('creates a Postgres instance with db.t4g.micro', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  it('is publicly accessible', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: true,
    });
  });

  it('has storage encryption enabled', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      StorageEncrypted: true,
    });
  });

  it('uses the correct database name', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBName: 'cah',
    });
  });

  it('enforces SSL via parameter group', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: {
        'rds.force_ssl': '1',
      },
    });
  });
});

// --- Secrets Manager Tests ---------------------------------------------------

describe('Secrets Manager', () => {
  it('creates a secret for RDS credentials', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        ExcludeCharacters: Match.anyValue(),
      }),
    });
  });

  it('creates a secret for agent credentials', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'cah-dev/agent-credentials',
    });
  });
});

// --- SQS Tests ---------------------------------------------------------------

describe('SQS Queue', () => {
  it('creates the main queue with 900-second visibility timeout', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 900,
    });
  });

  it('creates the main queue with correct name', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'cah-dev-jobs',
    });
  });

  it('creates a DLQ with 14-day retention', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'cah-dev-jobs-dlq',
      MessageRetentionPeriod: 1209600,
    });
  });

  it('configures DLQ with maxReceiveCount 3', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });
});

// --- IAM Tests ---------------------------------------------------------------

describe('IAM Policy', () => {
  it('includes S3 permissions scoped to bucket', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              's3:GetObject',
              's3:PutObject',
              's3:ListBucket',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('includes SQS permissions scoped to queue', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:GetQueueAttributes',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('includes Secrets Manager permissions scoped to secret', () => {
    const template = createTemplate();
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('does not use wildcard resource ARNs', () => {
    const template = createTemplate();
    const policies = template.findResources('AWS::IAM::ManagedPolicy');
    for (const [, policy] of Object.entries(policies)) {
      const props = policy.Properties as Record<string, unknown>;
      const doc = props.PolicyDocument as { Statement: Array<{ Resource: unknown }> };
      for (const statement of doc.Statement) {
        expect(statement.Resource).not.toBe('*');
        if (Array.isArray(statement.Resource)) {
          for (const resource of statement.Resource) {
            expect(resource).not.toBe('*');
          }
        }
      }
    }
  });
});

// --- Stack Outputs Tests -----------------------------------------------------

describe('Stack Outputs', () => {
  it('exports BucketName', () => {
    const template = createTemplate();
    template.hasOutput('BucketName', {});
  });

  it('exports DbEndpoint', () => {
    const template = createTemplate();
    // The database construct also exports DbEndpoint, and the stack also exports it.
    // Check that the stack-level output exists.
    template.hasOutput('DbEndpoint', {});
  });

  it('exports QueueUrl', () => {
    const template = createTemplate();
    template.hasOutput('QueueUrl', {});
  });

  it('exports SecretArn', () => {
    const template = createTemplate();
    template.hasOutput('SecretArn', {});
  });
});

// --- Stack Synthesis Test ----------------------------------------------------

describe('Stack Synthesis', () => {
  it('synthesizes without errors', () => {
    const app = new cdk.App();
    expect(() => new CahStack(app, 'SynthTestStack')).not.toThrow();
  });

  it('contains the expected number of resource types', () => {
    const template = createTemplate();
    // VPC, subnets, route tables, IGW, security groups, RDS, S3, SQS x2, IAM, Secrets
    const resources = template.toJSON().Resources;
    expect(Object.keys(resources).length).toBeGreaterThan(15);
  });
});

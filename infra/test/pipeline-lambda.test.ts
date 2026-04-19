/**
 * CDK assertion tests for pipeline Lambda construct.
 *
 * Validates that the synthesized CloudFormation template contains the
 * stage-router Lambda with correct configuration: timeout, runtime,
 * concurrency, IAM policies, SQS event sources, and environment variables.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CahStack } from '../lib/cah-stack.js';

// --- Test Setup --------------------------------------------------------------

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new CahStack(app, 'TestStack');
  template = Template.fromStack(stack);
});

// --- Lambda Configuration Tests ----------------------------------------------

describe('Pipeline Lambda Configuration', () => {
  it('creates Lambda function with 900-second timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 900,
    });
  });

  it('creates Lambda function with Node.js 22 runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  it('creates Lambda function with reserved concurrency of 10', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 10,
    });
  });
});

// --- SQS Stage Queue Tests ---------------------------------------------------

describe('Pipeline Stage Queue', () => {
  it('creates stage queue with 900-second visibility timeout', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'cah-dev-stage',
      VisibilityTimeout: 900,
    });
  });

  it('creates stage DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'cah-dev-stage-dlq',
    });
  });
});

// --- IAM Policy Tests --------------------------------------------------------

describe('Pipeline Lambda IAM Policy', () => {
  it('includes secretsmanager:GetSecretValue in IAM policy', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
          }),
        ]),
      }),
    });
  });

  it('includes S3 access in IAM policy', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject']),
          }),
        ]),
      }),
    });
  });

  it('includes SQS send and receive in IAM policy', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:GetQueueAttributes',
              'sqs:SendMessage',
            ]),
          }),
        ]),
      }),
    });
  });
});

// --- Lambda Environment Tests ------------------------------------------------

describe('Pipeline Lambda Environment', () => {
  it('Lambda environment contains ANTHROPIC_API_KEY_SECRET_ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ANTHROPIC_API_KEY_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('Lambda environment contains DB_SECRET_ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('Lambda environment contains STAGE_QUEUE_URL', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          STAGE_QUEUE_URL: Match.anyValue(),
        }),
      }),
    });
  });
});

// --- Stack Output Tests ------------------------------------------------------

describe('Pipeline Stack Outputs', () => {
  it('exports StageQueueUrl', () => {
    template.hasOutput('StageQueueUrl', {});
  });

  it('exports StageRouterFnArn', () => {
    template.hasOutput('StageRouterFnArn', {});
  });
});

// --- Stack Synthesis Test ----------------------------------------------------

describe('Stack Synthesis with Pipeline', () => {
  it('synthesizes without errors', () => {
    const app = new cdk.App();
    expect(() => new CahStack(app, 'SynthTestStack')).not.toThrow();
  });
});

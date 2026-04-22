#!/usr/bin/env npx ts-node
/**
 * CDK app entry point for Cloud Agent Harness infrastructure.
 *
 * Creates a single CahStack in us-east-1 containing all AWS resources
 * needed for the cloud agent platform (VPC, S3, RDS, SQS, IAM).
 */
import * as cdk from 'aws-cdk-lib';
import { CahStack } from '../lib/cah-stack.js';

const app = new cdk.App();
new CahStack(app, 'CahStack', {
  env: { region: 'us-east-1' },
  description: 'Cloud Agent Harness -- dev infrastructure',
  tags: { Environment: 'dev', Project: 'cah' },
});

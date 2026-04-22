/**
 * S3 storage construct for Cloud Agent Harness.
 *
 * Creates a single S3 bucket for pipeline artifacts and codebase maps.
 * Uses SSE-S3 encryption (not KMS -- simpler for v1).
 * Block all public access. DESTROY removal policy for dev teardown.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

// --- Props -------------------------------------------------------------------

/** Properties for the CahStorage construct. */
export interface CahStorageProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
}

// --- Construct ---------------------------------------------------------------

/**
 * S3 bucket for durable artifact storage.
 *
 * Key structure: `runs/{run_id}/phases/{phase}/` for pipeline artifacts,
 * `codebase/` for the codebase map (per D-12, D-15).
 *
 * @example
 * const storage = new CahStorage(this, 'Storage', { prefix: 'cah-dev' });
 * // storage.bucket is available for IAM policies
 */
export class CahStorage extends Construct {
  /** The S3 bucket created by this construct. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CahStorageProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'PipelineBucket', {
      bucketName: `${props.prefix}-pipeline-bucket`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}

/**
 * VPC networking construct for Cloud Agent Harness.
 *
 * Creates a VPC with public and isolated subnets across 2 AZs.
 * No NAT gateway -- saves ~$32/month for the dev environment.
 * Public subnets provide internet access for resources that need it.
 * Isolated subnets are available for internal-only resources.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

// --- Props -------------------------------------------------------------------

/** Properties for the CahNetworking construct. */
export interface CahNetworkingProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
}

// --- Construct ---------------------------------------------------------------

/**
 * VPC with public and isolated subnets, no NAT gateway.
 *
 * @example
 * const networking = new CahNetworking(this, 'Networking', { prefix: 'cah-dev' });
 * // networking.vpc is available for other constructs
 */
export class CahNetworking extends Construct {
  /** The VPC created by this construct. */
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: CahNetworkingProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.prefix}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    cdk.Tags.of(this.vpc).add('Name', `${props.prefix}-vpc`);
  }
}

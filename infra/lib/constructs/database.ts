/**
 * RDS Postgres database construct for Cloud Agent Harness.
 *
 * Creates a publicly accessible RDS Postgres 16 instance for agent runtime state.
 * Daytona Cloud sandboxes connect via public internet with SSL enforcement.
 * Credentials are generated and stored in Secrets Manager automatically.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// --- Props -------------------------------------------------------------------

/** Properties for the CahDatabase construct. */
export interface CahDatabaseProps {
  /** Resource name prefix (e.g., 'cah-dev'). */
  prefix: string;
  /** VPC to place the database instance in. */
  vpc: ec2.Vpc;
}

// --- Construct ---------------------------------------------------------------

/**
 * RDS Postgres 16 instance with Secrets Manager credentials and SSL enforcement.
 *
 * Publicly accessible for Daytona Cloud connectivity (no VPC peering available).
 * Security mitigations: SSL enforced via parameter group (T-01-01), credentials
 * in Secrets Manager (T-01-03), port 5432 only.
 *
 * @example
 * const db = new CahDatabase(this, 'Database', { prefix: 'cah-dev', vpc });
 * // db.instance and db.secret are available for IAM/outputs
 */
export class CahDatabase extends Construct {
  /** The RDS database instance. */
  public readonly instance: rds.DatabaseInstance;
  /** The Secrets Manager secret containing database credentials. */
  public readonly secret: ISecret;

  constructor(scope: Construct, id: string, props: CahDatabaseProps) {
    super(scope, id);

    // --- Security Group --------------------------------------------------------

    const securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: props.vpc,
      description: 'Allow Postgres access from Daytona Cloud (dynamic IPs)',
      allowAllOutbound: true,
    });

    // Daytona IPs are dynamic -- allow from anywhere, SSL enforced (T-01-01)
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      'Allow Postgres from Daytona Cloud (SSL enforced)',
    );

    // --- Parameter Group (SSL enforcement) -------------------------------------

    const parameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      parameters: {
        'rds.force_ssl': '1',
      },
      description: `${props.prefix} Postgres 16 parameter group with SSL enforcement`,
    });

    // --- RDS Instance ----------------------------------------------------------

    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: `${props.prefix}-agent-db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: true,
      securityGroups: [securityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('cah_admin'),
      databaseName: 'cah',
      parameterGroup,
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      multiAz: false,
      backupRetention: cdk.Duration.days(1),
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // The secret is automatically created by fromGeneratedSecret
    this.secret = this.instance.secret!;

    // --- Outputs ---------------------------------------------------------------

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.secret.secretArn,
      description: 'ARN of the Secrets Manager secret containing DB credentials',
    });

    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: this.instance.dbInstanceEndpointAddress,
      description: 'RDS instance endpoint address',
    });
  }
}

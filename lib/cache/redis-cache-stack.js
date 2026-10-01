const { Stack, Duration, RemovalPolicy } = require('aws-cdk-lib');
const elasticache = require('aws-cdk-lib/aws-elasticache');
const ec2 = require('aws-cdk-lib/aws-ec2');
const kms = require('aws-cdk-lib/aws-kms');
const iam = require('aws-cdk-lib/aws-iam');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');

class redisCache extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const prefix = `${props.environment}-${props.empCodigo}`;
    const enviromentDesc = `${props.envDescription}`;
    const vpcDatabase = props.vpcDatabase;

    /* Create parameter group */
    this.parameterGroup = new elasticache.CfnParameterGroup(this, 'parameterGroup', {
      cacheParameterGroupFamily: `${props.versionCache}`,
      description: `This is a ParameterGroup for Valkey in the ${enviromentDesc} environment.`,
    });

    /* Create subnet group */
    this.subnetGroup = new elasticache.CfnSubnetGroup(this, 'subnetGroupCache', {
      description: `This is a Subnet Group for Valkey in the ${enviromentDesc} environment`,
      cacheSubnetGroupName: `${prefix}-valkey-subnetgroup`,
      subnetIds: vpcDatabase.isolatedSubnets.map(subnet => subnet.subnetId),
    });

    /* Create security group */
    this.securityGroup = new ec2.SecurityGroup(this, 'CacheSG', {
      vpc: vpcDatabase,
      description: `This is a security group for Valkey cache in the ${enviromentDesc} environment. Allows inbound access only from VPC environments`,
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.cidrVPCEnvironments),
      ec2.Port.tcp(6379),
      'Allow traffic from vpc environments'
    );

    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.cidrVPCDataBase),
      ec2.Port.tcp(6379),
      'Allow traffic from vpc database'
    );

    /* Create KMS key policy */
    this.keyPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowRootAccountFullAccess',
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountRootPrincipal()],
          actions: ['kms:*'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'AllowElastiCacheUseKey',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('elasticache.amazonaws.com')],
          actions: [
            'kms:Encrypt',
            'kms:Decrypt',
            'kms:ReEncrypt*',
            'kms:GenerateDataKey*',
            'kms:DescribeKey',
          ],
          resources: ['*'],
        }),
      ],
    });

    /* Create KMS key for encryption at rest */
    this.kmsKey = new kms.Key(this, 'kmsKeyCache', {
      alias: `alias/${prefix}-valkey-key`,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      enableKeyRotation: true,
      rotationPeriod: Duration.days(90),
      policy: this.keyPolicy,
      description: `KMS key for Valkey encryption at rest in the ${enviromentDesc} environment.`,
    });

    /*
     * Store auth token in Secrets Manager.
     * NOTE: ElastiCache/Valkey does not have a HostedRotation native in AWS.
     * Automatic rotation requires a custom Lambda function.
     */
    this.authSecret = new secretsmanager.Secret(this, 'valkeyAuthSecret', {
      secretName: `${prefix}-valkey-auth-token`,
      description: `Auth token for Valkey in the ${enviromentDesc} environment`,
      encryptionKey: this.kmsKey,
      generateSecretString: {
        generateStringKey: 'authToken',
        secretStringTemplate: JSON.stringify({ engine: 'valkey' }),
        /* ElastiCache only allows printable ASCII except / @ " and spaces.
           excludePunctuation generates a safe alphanumeric-only token. */
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /* Create Valkey replication group — single primary, no replicas (dev) */
    this.valkeyCluster = new elasticache.CfnReplicationGroup(this, 'valkeyReplicationGroup', {
      replicationGroupDescription: `Valkey replication group for the ${enviromentDesc} environment`,
      replicationGroupId: `${prefix}-valkey`,
      engine: 'valkey',
      engineVersion: props.engineVersion,
      cacheNodeType: props.cacheNodeType ?? 'cache.t3.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      multiAzEnabled: false,
      cacheSubnetGroupName: this.subnetGroup.cacheSubnetGroupName,
      securityGroupIds: [this.securityGroup.securityGroupId],
      cacheParameterGroupName: this.parameterGroup.ref,
      atRestEncryptionEnabled: true,
      kmsKeyId: this.kmsKey.keyArn,
      transitEncryptionEnabled: true,
      transitEncryptionMode: 'required',
      authToken: this.authSecret.secretValueFromJson('authToken').unsafeUnwrap(),
      autoMinorVersionUpgrade: true,
      snapshotRetentionLimit: 1,
      preferredMaintenanceWindow: 'sun:05:00-sun:06:00',
    });

    this.valkeyCluster.addDependency(this.subnetGroup);
    this.valkeyCluster.addDependency(this.parameterGroup);
  }
}

module.exports = { redisCache };

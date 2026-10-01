const { Stack, Duration, RemovalPolicy } = require('aws-cdk-lib');
const rds = require('aws-cdk-lib/aws-rds');
const ec2 = require('aws-cdk-lib/aws-ec2');
const kms = require('aws-cdk-lib/aws-kms');
const iam = require('aws-cdk-lib/aws-iam');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
const logs = require('aws-cdk-lib/aws-logs');

class databaseRDSPostgresql extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const prefix = `${props.environment}-${props.empCodigo}`;
    const enviromentDesc = `${props.envDescription}`;
    const vpcDatabase = props.vpcDatabase;
    const vpcEnvironments = props.vpcEnvironments;

    // Security group para las rotation Lambdas (en vpcEnvironments con acceso a NAT)
    this.rotationSG = new ec2.SecurityGroup(this, 'RotationLambdaSG', {
        vpc: vpcEnvironments,
        description: 'Security group for Secrets Manager rotation Lambda functions database postgresql',
        allowAllOutbound: true,
    });

    /* Create parameter group */
    this.parameterGroup = new rds.ParameterGroup(this, 'parameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_4,
      }),
      name: `${prefix}-parameterGroup-postgresql`,
      description: `This is a ParameterGroup in the ${enviromentDesc} environment.`,
      copyTagsToSnapshot: true,
      parameters: {
        log_statement: 'all',
        log_min_duration_statement: '1000',
        log_connections: '1',
        log_disconnections: '1',
      },
    });

    /* Create subnet group */
    this.subnetGroup = new rds.SubnetGroup(this, 'subnetGroupDB', {
      description: `This is a Subnet Group for RDS PostgreSQL in the ${enviromentDesc} environment`,
      vpc: vpcDatabase,
      subnetGroupName: `${prefix}-rds-subnetgroup`,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    /* Create security group */
    this.securityGroup = new ec2.SecurityGroup(this, 'DataBaseSG', {
      vpc: vpcDatabase,
      description: `This is a security group for database in the ${enviromentDesc} environment. Allows inbound access only from VPC environments`,
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.cidrVPCEnvironments),
      ec2.Port.tcp(5432),
      'Allow traffic from vpc environments'
    );

    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.cidrVPCDataBase),
      ec2.Port.tcp(5432),
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
          sid: 'AllowRDSUseKey',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('rds.amazonaws.com')],
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
    this.kmsKey = new kms.Key(this, 'kmsKeyDatabase', {
      alias: `alias/${prefix}-rds-postgresql-key`,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      enableKeyRotation: true,
      rotationPeriod: Duration.days(90),
      policy: this.keyPolicy,
      description: `KMS key for RDS PostgreSQL encryption at rest in the ${enviromentDesc} environment.`,
    });

    /* Store root credentials in Secrets Manager */
    this.dbSecret = new secretsmanager.Secret(this, 'rdsSecret', {
      secretName: `${prefix}-rds-postgresql-root-credentials`,
      description: `Master credentials for RDS PostgreSQL in the ${enviromentDesc} environment`,
      encryptionKey: this.kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: props.dbUsername }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.dbSecret.addRotationSchedule('SecretRotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
        functionName: `${prefix}-rds-postgresql-master-rotation`,
        vpc: vpcEnvironments,
        excludeCharacters: '"@/:\'\\',
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.rotationSG],
      }),
      automaticallyAfter: Duration.days(30),
    });

    /* Create RDS PostgreSQL instance */
    this.databaseRDS = new rds.DatabaseInstance(this, 'databaseRDSPostgresql', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_4,
      }),
      instanceType: new ec2.InstanceType(props.instanceType ?? 't3.medium'),
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      vpc: vpcDatabase,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      subnetGroup: this.subnetGroup,
      parameterGroup: this.parameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: this.kmsKey,
      instanceIdentifier: `${prefix}-rds-postgresql`,
      deletionProtection: true,
      backupRetention: Duration.days(7),
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      cloudwatchLogsRetention: logs.RetentionDays.TWO_WEEKS,
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: this.kmsKey,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      autoMinorVersionUpgrade: true,
      multiAz: props.multiAz ?? false,
      allocatedStorage: props.allocatedStorage ?? 20,
      maxAllocatedStorage: props.maxAllocatedStorage ?? 100,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /* Create app user secret for Lambda functions (non-root) */
    this.lambdaUserSecret = new rds.DatabaseSecret(this, 'LambdaUserSecret', {
      username: `${prefix}-lambda-user`,
      masterSecret: this.dbSecret,
      encryptionKey: this.kmsKey,
      secretName: `${prefix}-rds-postgresql-lambda-credentials`,
    });

    /* Rotation for Lambda app user — also creates the user on first rotation */
    this.lambdaUserSecret.addRotationSchedule('LambdaUserRotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        functionName: `${prefix}-rds-postgresql-lambda-rotation`,
        masterSecret: this.dbSecret,
        vpc: vpcEnvironments,
        excludeCharacters: '"@/:\'\\',
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.rotationSG],
      }),
      automaticallyAfter: Duration.days(30),
    });

    /* Create app user secret for ECS services (non-root) */
    this.ecsUserSecret = new rds.DatabaseSecret(this, 'EcsUserSecret', {
      username: `${prefix}-ecs-user`,
      masterSecret: this.dbSecret,
      encryptionKey: this.kmsKey,
      secretName: `${prefix}-rds-postgresql-ecs-credentials`,
    });

    /* Rotation for ECS app user — also creates the user on first rotation */
    this.ecsUserSecret.addRotationSchedule('EcsUserRotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        functionName: `${prefix}-rds-postgresql-ecs-rotation`,
        masterSecret: this.dbSecret,
        vpc: vpcEnvironments,
        excludeCharacters: '"@/:\'\\',
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.rotationSG],
      }),
      automaticallyAfter: Duration.days(30),
    });
  }
}

module.exports = { databaseRDSPostgresql };

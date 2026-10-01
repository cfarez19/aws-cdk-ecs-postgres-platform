const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecr = require('aws-cdk-lib/aws-ecr');
const ec2 = require('aws-cdk-lib/aws-ec2');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const acm = require('aws-cdk-lib/aws-certificatemanager');
const kms = require('aws-cdk-lib/aws-kms');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');

class EcsServicesStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);

    // Use the VPC built by this project, or deploy into an existing one
    // (handy when migrating Elastic Beanstalk workloads in place).
    const vpc = props.vpcEnvironments
      ?? ec2.Vpc.fromLookup(this, 'ExistingVpc', { vpcId: props.existingVpcId });

    const prefix = `${props.environment}-${props.empCodigo}`;
    const enviromentDesc = `${props.envDescription}`;

    // ── ECS Cluster ───────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, `${prefix}-cluster`, {
      clusterName: `${prefix}-cluster`,
      vpc,
    });

    // ── Public ALB ────────────────────────────────────────────
    this.publicAlb = new elbv2.ApplicationLoadBalancer(this, `${prefix}-public-alb`, {
      loadBalancerName: `${prefix}-public-alb`,
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    this.publicAlb.addListener(`${prefix}-public-listener`, {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({ port: '443', protocol: 'HTTPS', permanent: true }),
    });

    const publicListener = this.publicAlb.addListener(`${prefix}-public-https-listener`, {
      port: 443,
      open: true,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not found',
      }),
    });

    // ── Internal ALB ──────────────────────────────────────────
    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, `${prefix}-internal-alb`, {
      loadBalancerName: `${props.environment}-internal-alb`,
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.internalAlb.addListener(`${prefix}-internal-listener`, {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({ port: '443', protocol: 'HTTPS', permanent: true }),
    });

    const internalListener = this.internalAlb.addListener(`${prefix}-internal-https-listener`, {
      port: 443,
      open: true,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not found',
      }),
    });

    new CfnOutput(this, 'PublicAlbDns', {
      exportName: `${prefix}-public-alb-dns`,
      value: this.publicAlb.loadBalancerDnsName,
      description: 'Public ALB DNS',
    });

    new CfnOutput(this, 'InternalAlbDns', {
      exportName: `${prefix}-internal-alb-dns`,
      value: this.internalAlb.loadBalancerDnsName,
      description: 'Internal ALB DNS',
    });

    this.repositories = {};
    this.services = {};
    this.targetGroups = {};
    this.taskRoles = {};

    // ── One ECR repo + Task Def + Fargate Service per entry ───
    for (const svc of props.services) {
      const svcPrefix = `${props.environment}-${svc.name}`;
      const isInternal = svc.albType === 'internal';
      const listener = isInternal ? internalListener : publicListener;
      const alb = isInternal ? this.internalAlb : this.publicAlb;

      // KMS Key
      const kmsKey = new kms.Key(this, `KmsKey-${svc.name}`, {
        alias: `alias/${svcPrefix}-ecr-key`,
        keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
        keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
        enableKeyRotation: true,
        rotationPeriod: Duration.days(90),
        description: `KMS key for ${svc.name} ECR in the ${enviromentDesc} environment.`,
      });

      // ECR Repository
      const repository = new ecr.Repository(this, `Ecr-${svc.name}`, {
        repositoryName: `${svcPrefix}`,
        encryption: ecr.RepositoryEncryption.KMS,
        encryptionKey: kmsKey,
        removalPolicy: RemovalPolicy.DESTROY,
        lifecycleRules: [
          {
            maxImageAge: Duration.days(30),
            description: 'Delete images older than 30 days',
          },
        ],
      });
      this.repositories[svc.name] = repository;

      // CloudWatch Log Group
      const logGroup = new logs.LogGroup(this, `LogGroup-${svc.name}`, {
        logGroupName: `/ecs/${svcPrefix}-td`,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      // Task Definition
      const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef-${svc.name}`, {
        family: `${svcPrefix}-td`,
        cpu: svc.cpu ?? 256,
        memoryLimitMiB: svc.memoryLimitMiB ?? 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        ephemeralStorageGiB: 30,
      });

      taskDef.addContainer(`Container-${svc.name}`, {
        containerName: `${svcPrefix}-container`,
        image: ecs.ContainerImage.fromEcrRepository(repository, svc.imageTag ?? 'latest'),
        essential: true,
        portMappings: [
          {
            name: `${svc.name}-port`,
            containerPort: svc.port ?? 80,
            protocol: ecs.Protocol.TCP,
            appProtocol: ecs.AppProtocol.http,
          },
        ],
        environment: {
            RDS_SECRET_ARN: props.ecsUserSecret.secretArn,
            RDS_ENDPOINT:   props.databaseRDS.dbInstanceEndpointAddress,
            RDS_PORT:       props.databaseRDS.dbInstanceEndpointPort,
            ...(props.cacheEndpoint ? { VALKEY_ENDPOINT: props.cacheEndpoint, VALKEY_PORT: '6379' } : {}),
            ...(svc.containerEnv ?? {}),
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: 'ecs',
        }),
      });

      // Permiso IAM al task role para leer el secret y KMS de RDS PostgreSQL
      taskDef.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [props.ecsUserSecret.secretArn],
      }));
      taskDef.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [props.dbKmsKey.keyArn],
      }));

      // Fargate Service
      const fargateService = new ecs.FargateService(this, `Service-${svc.name}`, {
        serviceName: `${svcPrefix}-service`,
        cluster: this.cluster,
        taskDefinition: taskDef,
        desiredCount: svc.desiredCount ?? 0,
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        healthCheckGracePeriod: Duration.seconds(120),
      });

      // Autoscaling on CPU and memory (opt-in per service)
      if (svc.autoscaling) {
        const scaling = fargateService.autoScaleTaskCount({
          minCapacity: svc.autoscaling.min ?? 1,
          maxCapacity: svc.autoscaling.max ?? 4,
        });
        scaling.scaleOnCpuUtilization(`ScaleOnCpu-${svc.name}`, {
          targetUtilizationPercent: svc.autoscaling.cpuTarget ?? 70,
          scaleInCooldown: Duration.seconds(120),
          scaleOutCooldown: Duration.seconds(60),
        });
        scaling.scaleOnMemoryUtilization(`ScaleOnMemory-${svc.name}`, {
          targetUtilizationPercent: svc.autoscaling.memoryTarget ?? 75,
          scaleInCooldown: Duration.seconds(120),
          scaleOutCooldown: Duration.seconds(60),
        });
      }

      // Allow ALB to reach the container port
      fargateService.connections.allowFrom(alb, ec2.Port.tcp(svc.port ?? 80));

      const tgConfig = {
        vpc,
        port: svc.port ?? 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: svc.healthCheckPath ?? '/',
          interval: Duration.seconds(30),
          healthyHttpCodes: '200-499',
        },
      };

      // Blue Target Group — active
      const blueTG = new elbv2.ApplicationTargetGroup(this, `TG-blue-${svc.name}`, {
        ...tgConfig,
        targetGroupName: `${svcPrefix}-blue-tg`,
        targets: [fargateService],
      });

      // Green Target Group — idle (blue/green switch desde Azure DevOps)
      const greenTG = new elbv2.ApplicationTargetGroup(this, `TG-green-${svc.name}`, {
        ...tgConfig,
        targetGroupName: `${svcPrefix}-green-tg`,
      });

      // Listener Rule — host-based si tiene subdominio, path-based si no
      const conditions = svc.subdomain
        ? [elbv2.ListenerCondition.hostHeaders([`${svc.subdomain}.${props.domain}`])]
        : [elbv2.ListenerCondition.pathPatterns([`${svc.pathPattern ?? `/${svc.name}`}*`])];

      new elbv2.ApplicationListenerRule(this, `Rule-${svc.name}`, {
        listener,
        priority: svc.priority,
        conditions,
        action: elbv2.ListenerAction.forward([blueTG]),
      });

      this.targetGroups[svc.name] = { blue: blueTG, green: greenTG };
      this.services[svc.name] = fargateService;
      this.taskRoles[svc.name] = taskDef.taskRole;

      new CfnOutput(this, `Output-blue-tg-${svc.name}`, {
        exportName: `${svcPrefix}-blue-tg-arn`,
        value: blueTG.targetGroupArn,
        description: `Blue TG ARN for ${svc.name}`,
      });

      new CfnOutput(this, `Output-green-tg-${svc.name}`, {
        exportName: `${svcPrefix}-green-tg-arn`,
        value: greenTG.targetGroupArn,
        description: `Green TG ARN for ${svc.name}`,
      });

      new CfnOutput(this, `Output-alb-${svc.name}`, {
        exportName: `${svcPrefix}-alb-arn`,
        value: alb.loadBalancerArn,
        description: `ALB ARN for ${svc.name} (${svc.albType ?? 'public'})`,
      });
    }
  }
}

module.exports = { EcsServicesStack };

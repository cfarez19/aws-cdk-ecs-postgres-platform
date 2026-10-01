const cdk = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { loadConfig } = require('../lib/config');
const { buildPlatform } = require('../lib/platform');

const ACCOUNT = '111122223333';

function build(name) {
  const config = loadConfig(name);
  const stacks = buildPlatform(new cdk.App(), config, { account: ACCOUNT });
  return { config, stacks };
}

describe('production config', () => {
  const { config, stacks } = build('example');
  const t = (s) => Template.fromStack(s);

  test('builds networking, database, cache and ECS stacks', () => {
    expect(Object.keys(stacks).sort()).toEqual(['cache', 'database', 'ecs', 'peering', 'vpcDb', 'vpcEnv']);
  });

  test('PostgreSQL is encrypted, Multi-AZ and protected from deletion', () => {
    t(stacks.database).hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      StorageEncrypted: true,
      MultiAZ: true,
      DeletionProtection: true,
      EnablePerformanceInsights: true,
      DBInstanceClass: 'db.m6g.large',
    });
  });

  test('database lives in isolated subnets of its own VPC', () => {
    t(stacks.vpcDb).resourceCountIs('AWS::EC2::NatGateway', 0);
    t(stacks.vpcDb).resourceCountIs('AWS::EC2::InternetGateway', 0);
  });

  test('master, ECS and Lambda database users rotate automatically', () => {
    t(stacks.database).resourceCountIs('AWS::SecretsManager::RotationSchedule', 3);
  });

  test('Valkey requires TLS and encrypts at rest', () => {
    t(stacks.cache).hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'valkey',
      TransitEncryptionEnabled: true,
      AtRestEncryptionEnabled: true,
    });
  });

  test('one Fargate service per configured service, with KMS-encrypted ECR', () => {
    const ecs = t(stacks.ecs);
    ecs.resourceCountIs('AWS::ECS::Service', config.services.length);
    ecs.resourceCountIs('AWS::ECR::Repository', config.services.length);
    ecs.hasResourceProperties('AWS::ECR::Repository', {
      EncryptionConfiguration: { EncryptionType: 'KMS', KmsKey: Match.anyValue() },
    });
  });

  test('autoscaling only where configured', () => {
    const withScaling = config.services.filter((s) => s.autoscaling).length;
    t(stacks.ecs).resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', withScaling);
  });

  test('containers receive the cache endpoint', () => {
    t(stacks.ecs).hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([Match.objectLike({ Name: 'VALKEY_ENDPOINT' })]),
      })],
    });
  });
});

describe('development config', () => {
  const { stacks } = build('dev');

  test('skips the cache and runs a single-AZ database', () => {
    expect(stacks.cache).toBeUndefined();
    Template.fromStack(stacks.database).hasResourceProperties('AWS::RDS::DBInstance', { MultiAZ: false });
  });
});

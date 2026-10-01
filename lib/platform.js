/**
 * Wires the stacks together. Shared by bin/app.js and the tests.
 */
const { vpcEnvironents } = require('./vpc/vpc-environment-stack');
const { vpcDataBase } = require('./vpc/vpc-database-stack');
const { vpcPeeringConnection } = require('./vpc/vpc-peering-connection-stack');
const { databaseRDSPostgresql } = require('./database/database-rds-postresql-stack');
const { redisCache } = require('./cache/redis-cache-stack');
const { EcsServicesStack } = require('./environments/ecs-services-stack');

function buildPlatform(app, c, { account }) {
  const env = { account, region: c.region };
  const prefix = `${c.environment}-${c.clientCode}`;
  const base = { empCodigo: c.clientCode, environment: c.environment };
  const description = c.description || c.environment;
  const stacks = {};

  // ── Networking: app VPC + isolated DB VPC + peering ──────────
  stacks.vpcEnv = new vpcEnvironents(app, `${prefix}-vpcEnvironments`, { ...base, cidrVPCEnvironments: c.cidrEnvironments, env });
  stacks.vpcDb = new vpcDataBase(app, `${prefix}-vpcDatabase`, { ...base, cidrVPCDataBase: c.cidrDatabase, env });
  stacks.peering = new vpcPeeringConnection(app, `${prefix}-vpcPeering`, {
    ...base, vpcEnvironments: stacks.vpcEnv.VpcEnvironments, vpcDatabase: stacks.vpcDb.vpcDataBase, env,
  });

  // ── RDS PostgreSQL: KMS, Performance Insights, rotated users ─
  const db = c.database || {};
  stacks.database = new databaseRDSPostgresql(app, `${prefix}-rdsPostgresql`, {
    ...base,
    envDescription: description,
    vpcDatabase: stacks.vpcDb.vpcDataBase,
    vpcEnvironments: stacks.vpcEnv.VpcEnvironments,
    cidrVPCDataBase: c.cidrDatabase,
    cidrVPCEnvironments: c.cidrEnvironments,
    dbUsername: db.username || `${c.clientCode}Admin`,
    instanceType: db.instanceType,
    multiAz: db.multiAz,
    allocatedStorage: db.allocatedStorage,
    maxAllocatedStorage: db.maxAllocatedStorage,
    env,
  });

  // ── Valkey (Redis-compatible) cache, TLS required ────────────
  if (c.cache && c.cache.enabled) {
    stacks.cache = new redisCache(app, `${prefix}-valkeyCache`, {
      ...base,
      envDescription: description,
      vpcDatabase: stacks.vpcDb.vpcDataBase,
      versionCache: c.cache.parameterFamily || 'valkey8',
      engineVersion: c.cache.engineVersion || '8.0',
      cacheNodeType: c.cache.nodeType || 'cache.t3.micro',
      cidrVPCDataBase: c.cidrDatabase,
      cidrVPCEnvironments: c.cidrEnvironments,
      env,
    });
  }

  // ── ECS Fargate services behind public + internal ALBs ───────
  stacks.ecs = new EcsServicesStack(app, `${prefix}-EcsStack`, {
    ...base,
    env,
    envDescription: description,
    vpcEnvironments: stacks.vpcEnv.VpcEnvironments,
    certificateArn: c.certificateArn,
    domain: c.domain,
    databaseRDS: stacks.database.databaseRDS,
    ecsUserSecret: stacks.database.ecsUserSecret,
    dbKmsKey: stacks.database.kmsKey,
    cacheEndpoint: stacks.cache ? stacks.cache.valkeyCluster.attrPrimaryEndPointAddress : undefined,
    services: c.services,
  });

  return stacks;
}

module.exports = { buildPlatform };

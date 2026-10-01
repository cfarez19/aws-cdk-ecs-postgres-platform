#!/usr/bin/env node
/**
 * ECS Fargate + RDS PostgreSQL + Valkey platform — CDK entry point.
 *
 *   npx cdk deploy --all -c config=prod
 *
 * The AWS account comes from your CLI profile (CDK_DEFAULT_ACCOUNT).
 */
const cdk = require('aws-cdk-lib');
const { loadConfig } = require('../lib/config');
const { buildPlatform } = require('../lib/platform');

const app = new cdk.App();
const config = loadConfig(app.node.tryGetContext('config') || 'dev');
buildPlatform(app, config, { account: process.env.CDK_DEFAULT_ACCOUNT });

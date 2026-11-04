#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { GenAiAppStack } from '../lib/genai-app-stack';

const app = new cdk.App();

new GenAiAppStack(app, 'BedrockGenAiAppStack', {
  // The model is a context value so it can change without touching code:
  //   cdk deploy -c modelId=us.anthropic.claude-haiku-4-5-20251001-v1:0
  modelId: app.node.tryGetContext('modelId'),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface GenAiAppStackProps extends cdk.StackProps {
  /** Bedrock model or inference profile ID the agent uses. */
  readonly modelId: string;
}

export class GenAiAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GenAiAppStackProps) {
    super(scope, id, props);

    const { account, region, partition } = cdk.Stack.of(this);

    // =====================================================================
    // Part 1: a retrieval (RAG) application on a managed knowledge base
    // =====================================================================

    // Documents live in S3. Removed with the stack so teardown is complete.
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const docsPrefix = 'books/';
    const upload = new s3deploy.BucketDeployment(this, 'UploadBooks', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'data'))],
      destinationBucket: docsBucket,
      destinationKeyPrefix: docsPrefix,
    });

    // The knowledge base reads the documents with this role.
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock:${region}:${account}:knowledge-base/*` },
        },
      }),
    });
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ListBooksBucket',
      actions: ['s3:ListBucket'],
      resources: [docsBucket.bucketArn],
      conditions: { StringEquals: { 'aws:ResourceAccount': account } },
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadBooks',
      actions: ['s3:GetObject'],
      resources: [docsBucket.arnForObjects(`${docsPrefix}*`)],
      conditions: { StringEquals: { 'aws:ResourceAccount': account } },
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'AWS/Bedrock/KnowledgeBases' } },
    }));

    // A managed knowledge base: Amazon Bedrock runs parsing, chunking,
    // embedding and the vector store. There is no vector database to define.
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${this.stackName}-books`,
      description: 'Classic novels from Project Gutenberg',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: { embeddingModelType: 'MANAGED' },
      },
    });
    knowledgeBase.node.addDependency(kbRole);

    const dataSource = new bedrock.CfnDataSource(this, 'BooksDataSource', {
      name: 'books-s3',
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          // Connector parameters are passed through as-is, so keys are camelCase.
          connectorParameters: {
            type: 'S3',
            version: '1',
            connectionConfiguration: {
              bucketName: docsBucket.bucketName,
              bucketOwnerAccountId: account,
            },
            filterConfiguration: { inclusionPrefixes: [docsPrefix] },
          },
          deletionProtectionConfiguration: { deletionProtectionStatus: 'DISABLED' },
        },
      },
      vectorIngestionConfiguration: {
        parsingConfiguration: { parsingStrategy: 'SMART_PARSING' },
      },
    });

    // Run the first sync on deploy so the knowledge base is usable right away.
    const ingest = new cr.AwsCustomResource(this, 'StartIngestion', {
      installLatestAwsSdk: false,
      onCreate: {
        service: 'bedrock-agent',
        action: 'StartIngestionJob',
        parameters: {
          knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
          dataSourceId: dataSource.attrDataSourceId,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('ingestionJob.ingestionJobId'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock:StartIngestionJob'],
          resources: [knowledgeBase.attrKnowledgeBaseArn],
        }),
      ]),
    });
    ingest.node.addDependency(upload);

    // =====================================================================
    // Part 2: an agent that uses the knowledge base as a tool
    // =====================================================================

    // The gateway calls the knowledge base with this role.
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${region}:${account}:gateway/*` },
        },
      }),
    });
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:GetKnowledgeBase', 'bedrock:Retrieve'],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }));

    // An MCP gateway. Callers sign requests with IAM (SigV4).
    const gateway = new agentcore.CfnGateway(this, 'ToolGateway', {
      name: 'literature-tools',
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gatewayRole.roleArn,
    });
    gateway.node.addDependency(gatewayRole);

    // The built-in knowledge base connector exposes the knowledge base as an MCP tool.
    const kbTarget = new agentcore.CfnGatewayTarget(this, 'KnowledgeBaseTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: 'books',
      description: 'Search the full text of classic novels',
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: 'bedrock-knowledge-bases' },
            configurations: [{
              name: 'Retrieve',
              description: 'Search the novels for passages relevant to a question.',
              parameterValues: {
                knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
                // A novel is long, so return more passages than the default per search.
                retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: 10 } },
              },
            }],
          },
        },
      },
    });

    // An inference profile ID such as us.amazon.nova-2-lite-v1:0 maps to the base model amazon.nova-2-lite-v1:0.
    const baseModelId = props.modelId.replace(/^(us|eu|apac|jp|au|us-gov|global)\./, '');

    // The harness name is used to scope the agent role to this one agent.
    const harnessName = 'LiteratureAgent';

    // The agent runs as this role.
    const harnessRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${region}:${account}:*` },
        },
      }),
    });
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeModel',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:${partition}:bedrock:*::foundation-model/${baseModelId}`,
        `arn:${partition}:bedrock:${region}:${account}:inference-profile/${props.modelId}`,
      ],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeGateway',
      actions: ['bedrock-agentcore:InvokeGateway'],
      resources: [gateway.attrGatewayArn],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PullManagedImage',
      actions: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken'],
      resources: ['*'],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Logs',
      actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/harness_${harnessName}-*`],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Observability',
      actions: ['logs:DescribeLogGroups', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
        'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
      resources: ['*'],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Metrics',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WorkloadIdentity',
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT'],
      resources: [
        `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
        `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/harness_${harnessName}-*`,
      ],
    }));

    // The agent: declare the model, instructions and tools. AgentCore runs the loop.
    const harness = new agentcore.CfnHarness(this, 'LiteratureAgent', {
      harnessName,
      executionRoleArn: harnessRole.roleArn,
      model: { bedrockModelConfig: { modelId: props.modelId } },
      systemPrompt: [{
        text: 'You answer questions about books using only the books tool. Search the tool before '
          + 'every answer, and search again with different words if the first results are not enough. '
          + 'Answer only from the passages the tool returns, never from your own knowledge of the book, '
          + 'and quote the short passage that supports each claim. If the passages do not contain the '
          + 'answer, reply that you could not find it in the documents.',
      }],
      tools: [{
        type: 'agentcore_gateway',
        name: 'books',
        config: { agentCoreGateway: { gatewayArn: gateway.attrGatewayArn, outboundAuth: { awsIam: {} } } },
      }],
      // Only the knowledge base tools. Without this the agent also gets the built-in
      // shell and file_operations tools, which this app does not need.
      allowedTools: ['@books'],
      // No conversation memory: each session starts fresh and nothing persists after teardown.
      memory: { disabled: {} },
      maxIterations: 10,
      timeoutSeconds: 300,
    });
    harness.node.addDependency(harnessRole);
    harness.node.addDependency(kbTarget);

    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId });
    new cdk.CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, 'HarnessArn', { value: harness.attrArn });
    new cdk.CfnOutput(this, 'ModelId', { value: props.modelId });
  }
}

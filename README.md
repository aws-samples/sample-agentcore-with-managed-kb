# Build generative AI applications with Amazon Bedrock and AWS CDK

This repository contains the sample code for the AWS blog post *Build generative AI applications with Amazon Bedrock and AWS CDK*. One AWS Cloud Development Kit (AWS CDK) stack deploys two parts:

1. **Retrieval (RAG):** an Amazon Simple Storage Service (Amazon S3) bucket of documents connected to an Amazon Bedrock Managed Knowledge Base. Amazon Bedrock handles parsing, chunking, embedding and the vector store.
2. **Agent:** an Amazon Bedrock AgentCore harness that answers questions with the knowledge base as its only tool, reached through an AgentCore Gateway.

The sample answers questions about *Pride and Prejudice* from Project Gutenberg. You can replace the book with your own documents.

**This is sample code for learning and experimentation. It is not production-ready.** It favors simplicity over hardening: for example, the bucket does not have server access logging, encryption uses AWS managed keys instead of customer managed keys, and the agent runs on the public network. Review the [Security](#security) section and your own requirements before you adapt it for production.

**Cost.** The stack creates billable resources. A managed knowledge base is billed for storage and retrieval calls, the model is billed per token, and the AgentCore harness has no separate charge but you pay for the AgentCore capabilities it uses. See [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) and [Amazon Bedrock AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/). Delete the stack when you finish (see [Clean up](#clean-up)).

![Architecture diagram: a local web page or script sends questions to an Amazon Bedrock AgentCore harness, which calls Amazon Nova 2 Lite and reaches an Amazon Bedrock Managed Knowledge Base on Amazon S3 through an AgentCore Gateway. One AWS CDK app deploys all of it.](docs/architecture.png)

## Prerequisites

- An AWS account and an AWS Identity and Access Management (IAM) principal that can create the resources in the stack.
- Node.js 20 or later and the AWS CDK CLI. Run `npx cdk bootstrap` once for your account and Region.
- Python 3 with a recent version of `boto3` (tested with 1.43) for the test script.
- Access to the model you plan to use in Amazon Bedrock. The default is Amazon Nova 2 Lite.
- A Region where Amazon Bedrock Managed Knowledge Bases, Amazon Bedrock AgentCore and your model are available. See [Supported AWS Regions for AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) and [model support by Region](https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html).

The stack uses only constructs from `aws-cdk-lib` (pinned to 2.275.0).

## Deploy

```bash
npm install
npx cdk deploy --outputs-file outputs.json
```

Deployment takes a few minutes, and the first sync of the sample book takes about two more. `outputs.json` holds the IDs of your resources and is excluded from version control.

The default model is the US cross-Region inference profile `us.amazon.nova-2-lite-v1:0`. To use another model or profile, pass it as context:

```bash
npx cdk deploy -c modelId=global.amazon.nova-2-lite-v1:0 --outputs-file outputs.json
```

## Try it

Ask the agent from the command line:

```bash
python3 scripts/ask_agent.py "Why is Mrs. Bennet so excited when Mr. Bingley rents Netherfield Park?"
```

Or run the local web page, which shows the answer and the retrieved passages side by side:

```bash
cd ui
npm install
npm start
```

Then open http://127.0.0.1:8790. The page runs on your machine, listens on `127.0.0.1` only, and calls the agent with your local AWS credentials. It is not intended to be hosted. To share it with other people, put it behind sign-in and an API rather than exposing the local server.

## Use your own documents

Replace the files in `data/` and deploy again, then start a sync from the Amazon Bedrock console or with `StartIngestionJob`. The stack only runs the first sync automatically.

## Clean up

```bash
npx cdk destroy --all
```

Deletion can take 10 to 15 minutes. The stack's helper functions and the agent leave Amazon CloudWatch log groups behind. Remove them with:

```bash
for g in $(aws logs describe-log-groups \
  --query "logGroups[?contains(logGroupName,'BedrockGenAiAppStack') || contains(logGroupName,'harness_LiteratureAgent')].logGroupName" \
  --output text); do
  aws logs delete-log-group --log-group-name "$g"
done
```

## Project layout

| Path | Contents |
|---|---|
| `bin/app.ts` | CDK app entry point and model context value |
| `lib/genai-app-stack.ts` | The stack: Part 1 (knowledge base) and Part 2 (gateway and agent) |
| `data/` | Sample document uploaded to the knowledge base |
| `scripts/ask_agent.py` | Command-line client for the agent |
| `ui/` | Optional local web page built with the Cloudscape Design System |

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

Before you use this in production, review the IAM policies, enable server access logging on the bucket, consider customer managed encryption keys, restrict network access for the agent, and set log retention. Do not expose the local web page to other users without adding sign-in.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

The sample book in `data/` is from [Project Gutenberg](https://www.gutenberg.org/ebooks/1342) and is distributed under the Project Gutenberg License included in the file.

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Ask the deployed agent a question and print the streamed answer and tool calls.

Usage: python3 scripts/ask_agent.py "<question>"
Reads HarnessArn from outputs.json written by `npx cdk deploy --outputs-file outputs.json`.
"""
import json
import sys
import time
import uuid

import boto3

outputs = json.load(open("outputs.json"))["BedrockGenAiAppStack"]
harness_arn = outputs["HarnessArn"]
region = harness_arn.split(":")[3]
question = sys.argv[1] if len(sys.argv) > 1 else "Why is Mrs. Bennet excited about Mr. Bingley?"

client = boto3.client("bedrock-agentcore", region_name=region)
start = time.time()
response = client.invoke_harness(
    harnessArn=harness_arn,
    runtimeSessionId=str(uuid.uuid4()),  # must be at least 33 characters
    messages=[{"role": "user", "content": [{"text": question}]}],
)

tools_called = []
for event in response["stream"]:
    if "contentBlockStart" in event:
        start_block = event["contentBlockStart"].get("start", {})
        if "toolUse" in start_block:
            tools_called.append(start_block["toolUse"].get("name"))
    elif "contentBlockDelta" in event:
        delta = event["contentBlockDelta"].get("delta", {})
        if "text" in delta:
            print(delta["text"], end="", flush=True)
    elif "messageStop" in event:
        print(f"\n[stop: {event['messageStop'].get('stopReason')}]")
    elif "metadata" in event:
        usage = event["metadata"].get("usage", {})
        if usage:
            print(f"[tokens in={usage.get('inputTokens')} out={usage.get('outputTokens')}]")
    elif "runtimeClientError" in event:
        print(f"\nERROR: {event['runtimeClientError'].get('message')}")

print(f"\n[tools called: {tools_called}] [{time.time() - start:.1f}s]")

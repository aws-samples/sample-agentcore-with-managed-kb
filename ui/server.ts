// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Local server for the literature assistant.
 *
 * Runs on your machine and listens on 127.0.0.1 only. It forwards each question to the
 * AgentCore harness in your AWS account, signed with your own AWS credentials, and streams
 * the answer and the retrieved passages back to the page as server-sent events.
 * The browser never holds AWS credentials.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { AgentEvent, AppInfo, Passage } from './shared';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8790);
const MAX_QUESTION_CHARS = 2000;
const MAX_BODY_BYTES = 10_000;
// Only requests addressed to this server are accepted. Checking Host blocks DNS rebinding,
// and checking Origin and Content-Type blocks cross-site requests from other open pages.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const CSP = "default-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
const here = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(here, 'dist');

const outputsPath = join(here, '..', 'outputs.json');
if (!existsSync(outputsPath)) {
  console.error('outputs.json not found. Deploy first with: npx cdk deploy --outputs-file outputs.json');
  process.exit(1);
}
const outputs = JSON.parse(readFileSync(outputsPath, 'utf8')).BedrockGenAiAppStack;
const harnessArn: string = outputs.HarnessArn;
const region = harnessArn.split(':')[3];
const info: AppInfo = {
  region,
  modelId: outputs.ModelId ?? 'unknown',
  knowledgeBaseId: outputs.KnowledgeBaseId,
  harnessName: harnessArn.split('/').pop() ?? '',
};
const client = new BedrockAgentCoreClient({ region });

function send(res: ServerResponse, event: AgentEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function parsePassages(raw: string): Passage[] {
  try {
    const results = JSON.parse(raw).retrievalResults ?? [];
    return results.map((r: any, i: number) => ({
      id: r.metadata?._chunk_id ?? String(i),
      text: String(r.content?.text ?? '')
        .replace(/\[Illustration[^\]]*\]/g, '')   // drop illustration captions
        .replace(/\n{2,}/g, '\u2029')                // keep paragraph breaks
        .replace(/\s*\n\s*/g, ' ')                  // unwrap hard line breaks
        .replace(/\u2029/g, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
      score: Number(r.score ?? 0),
      source: r.metadata?._document_title ?? 'document',
    }));
  } catch {
    return [];
  }
}

async function ask(question: string, res: ServerResponse): Promise<void> {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = '';
  // Tool calls and tool results arrive in chunks, keyed by content block.
  const toolInput = new Map<number, { name: string; input: string }>();
  const toolResult = new Map<number, string>();

  const response = await client.send(new InvokeHarnessCommand({
    harnessArn,
    runtimeSessionId: randomUUID(), // at least 33 characters; one session per question
    messages: [{ role: 'user', content: [{ text: question }] }],
  }));

  for await (const event of response.stream ?? []) {
    if (event.contentBlockStart?.start?.toolUse) {
      toolInput.set(event.contentBlockStart.contentBlockIndex ?? 0,
        { name: event.contentBlockStart.start.toolUse.name ?? 'tool', input: '' });
    } else if (event.contentBlockStart?.start?.toolResult) {
      toolResult.set(event.contentBlockStart.contentBlockIndex ?? 0, '');
    } else if (event.contentBlockDelta) {
      const index = event.contentBlockDelta.contentBlockIndex ?? 0;
      const delta: any = event.contentBlockDelta.delta ?? {};
      if (typeof delta.text === 'string') send(res, { type: 'text', text: delta.text });
      if (delta.toolUse?.input && toolInput.has(index)) toolInput.get(index)!.input += delta.toolUse.input;
      if (Array.isArray(delta.toolResult) && toolResult.has(index)) {
        toolResult.set(index, toolResult.get(index)! + delta.toolResult.map((b: any) => b.text ?? '').join(''));
      }
    } else if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex ?? 0;
      const call = toolInput.get(index);
      if (call) {
        let query = '';
        try { query = JSON.parse(call.input).retrievalQuery?.text ?? ''; } catch { /* partial input */ }
        send(res, { type: 'tool', name: call.name, query });
        toolInput.delete(index);
      }
      const result = toolResult.get(index);
      if (result !== undefined) {
        send(res, { type: 'sources', passages: parsePassages(result) });
        toolResult.delete(index);
      }
    } else if (event.messageStop) {
      stopReason = event.messageStop.stopReason ?? stopReason;
    } else if (event.metadata?.usage) {
      inputTokens += event.metadata.usage.inputTokens ?? 0;
      outputTokens += event.metadata.usage.outputTokens ?? 0;
    } else if (event.runtimeClientError) {
      send(res, { type: 'error', message: event.runtimeClientError.message ?? 'Agent error' });
    }
  }
  send(res, { type: 'done', elapsedMs: Date.now() - started, inputTokens, outputTokens, stopReason });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin GETs and non-browser clients send no Origin
  try {
    return ALLOWED_HOSTS.has(new URL(origin).host);
  } catch {
    return false;
  }
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  // Same-origin only: no remote images, scripts or connections, and no framing.
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '') || !isAllowedOrigin(req.headers.origin)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}`);

  if (url.pathname === '/api/info' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
    return;
  }

  if (url.pathname === '/api/ask' && req.method === 'POST') {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      res.writeHead(415).end('Content-Type must be application/json');
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      res.writeHead(413).end('Request too large');
      return;
    }
    let question = '';
    try {
      question = String(JSON.parse(await readBody(req)).question ?? '').trim();
    } catch {
      res.writeHead(400).end('Invalid request');
      return;
    }
    if (!question || question.length > MAX_QUESTION_CHARS) {
      res.writeHead(400).end(`Question must be 1 to ${MAX_QUESTION_CHARS} characters`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      await ask(question, res);
    } catch (err) {
      // Log the full error locally, but send only a generic message to the browser.
      console.error(err);
      send(res, { type: 'error', message: 'The agent call failed. See the server console for details.' });
    }
    res.end();
    return;
  }

  // Static files from the built page. Fall back to index.html for anything that isn't a file
  // inside dist/, including directories, so a request like /assets can't stop the server.
  const requested = normalize(join(distDir, url.pathname === '/' ? 'index.html' : url.pathname));
  const index = join(distDir, 'index.html');
  const file = requested.startsWith(distDir + sep) && isFile(requested) ? requested : index;
  if (!isFile(file)) {
    res.writeHead(500).end('Page not built. Run: npm start');
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(500).end('Could not read file');
    return;
  }
  res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`Literature assistant running at http://${HOST}:${PORT}`);
  console.log(`Agent: ${info.harnessName} (${info.modelId}) in ${info.region}`);
});

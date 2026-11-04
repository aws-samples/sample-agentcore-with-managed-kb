// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** Events the local server streams to the browser for one question. */
export interface Passage {
  id: string;
  text: string;
  score: number;
  source: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; query: string }
  | { type: 'sources'; passages: Passage[] }
  | { type: 'done'; elapsedMs: number; inputTokens: number; outputTokens: number; stopReason: string }
  | { type: 'error'; message: string };

export interface AppInfo {
  region: string;
  modelId: string;
  knowledgeBaseId: string;
  harnessName: string;
}

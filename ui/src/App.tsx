// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import AppLayout from '@cloudscape-design/components/app-layout';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import Avatar from '@cloudscape-design/chat-components/avatar';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import SupportPromptGroup from '@cloudscape-design/chat-components/support-prompt-group';
import type { AgentEvent, AppInfo, Passage } from '../shared';

interface Turn {
  id: string;
  question: string;
  answer: string;
  searches: string[];
  passages: Passage[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
  elapsedMs?: number;
  tokens?: number;
}

const SAMPLE_QUESTIONS = [
  { id: 'q1', text: 'Why is Mrs. Bennet so excited when Mr. Bingley rents Netherfield Park?' },
  { id: 'q2', text: 'Who does Elizabeth Bennet eventually marry?' },
  { id: 'q3', text: 'What does Mr. Darcy say about Elizabeth at the first ball?' },
  { id: 'q4', text: 'What does Sherlock Holmes say about Mr. Darcy?' },
];

const normalize = (s: string) => s.replace(/[*_\u201c\u201d\u2018\u2019"']/g, '').replace(/\s+/g, ' ').toLowerCase().trim();

/** Passages the answer quotes from, found by matching quoted text in the answer. */
function quotedPassageIds(answer: string, passages: Passage[]): Set<string> {
  const ids = new Set<string>();
  const quotes = [...answer.matchAll(/[\u201c"]([^\u201d"]{16,})[\u201d"]/g)].map((m) => normalize(m[1]).slice(0, 48));
  for (const p of passages) {
    const text = normalize(p.text);
    if (quotes.some((q) => text.includes(q))) ids.add(p.id);
  }
  return ids;
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState('');
  const busy = turns.some((t) => t.status === 'streaming');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/info').then((r) => r.json()).then(setInfo).catch(() => setInfo(null));
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns]);

  const update = (id: string, change: (t: Turn) => Turn) =>
    setTurns((all) => all.map((t) => (t.id === id ? change(t) : t)));

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const id = crypto.randomUUID();
    setPrompt('');
    setTurns((all) => [...all, { id, question: text, answer: '', searches: [], passages: [], status: 'streaming' }]);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6)) as AgentEvent;
          update(id, (t) => {
            switch (event.type) {
              case 'text': return { ...t, answer: t.answer + event.text };
              case 'tool': return { ...t, searches: [...t.searches, event.query || 'search'] };
              case 'sources': {
                const seen = new Set(t.passages.map((p) => p.id));
                const merged = [...t.passages, ...event.passages.filter((p) => !seen.has(p.id))];
                return { ...t, passages: merged.sort((a, b) => b.score - a.score) };
              }
              case 'done': return { ...t, status: 'done', elapsedMs: event.elapsedMs, tokens: event.inputTokens + event.outputTokens };
              case 'error': return { ...t, status: 'error', error: event.message };
            }
          });
        }
      }
      update(id, (t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t));
    } catch (err) {
      update(id, (t) => ({ ...t, status: 'error', error: err instanceof Error ? err.message : String(err) }));
    }
  }

  const latest = turns[turns.length - 1];
  const quoted = latest && latest.status === 'done' ? quotedPassageIds(latest.answer, latest.passages) : new Set<string>();
  // Passages the answer quotes come first, then the rest by relevance score.
  const ordered = latest ? [...latest.passages].sort((a, b) => Number(quoted.has(b.id)) - Number(quoted.has(a.id)) || b.score - a.score) : [];

  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{ href: '#', title: 'Literature assistant' }}
          utilities={[
            { type: 'button', text: info ? `${info.region}` : 'Connecting', iconName: 'globe' },
            { type: 'button', text: 'Amazon Bedrock AgentCore', iconName: 'gen-ai' },
          ]}
        />
      </div>
      <AppLayout
        headerSelector="#top-nav"
        navigationHide
        toolsHide
        content={
          <ContentLayout
            header={
              <Header variant="h1" description="Ask questions about the books in your knowledge base. Every answer is grounded in retrieved passages.">
                Ask the books
              </Header>
            }
          >
            <SpaceBetween size="l">
              <Container>
                <ColumnLayout columns={4} variant="text-grid">
                  <Detail label="Agent" value={info?.harnessName} />
                  <Detail label="Model" value={info?.modelId} />
                  <Detail label="Knowledge base" value={info?.knowledgeBaseId} />
                  <Detail label="Tool" value="books (AgentCore Gateway)" />
                </ColumnLayout>
              </Container>

              <Grid gridDefinition={[{ colspan: { default: 12, s: 8 } }, { colspan: { default: 12, s: 4 } }]}>
                <Container
                  header={<Header variant="h2">Conversation</Header>}
                  footer={
                    <PromptInput
                      value={prompt}
                      onChange={({ detail }) => setPrompt(detail.value)}
                      onAction={() => ask(prompt)}
                      actionButtonIconName="send"
                      actionButtonAriaLabel="Send question"
                      disableActionButton={busy || !prompt.trim()}
                      placeholder="Ask a question about the books"
                      minRows={1}
                      maxRows={4}
                    />
                  }
                >
                  <div className="conversation">
                    {turns.length === 0 ? (
                      <Box textAlign="center" padding={{ vertical: 'xl' }}>
                        <SpaceBetween size="m">
                          <div className="center"><Avatar color="gen-ai" iconName="gen-ai" ariaLabel="Assistant" width={48} /></div>
                          <Box variant="h3">What would you like to know?</Box>
                          <Box color="text-body-secondary">Try one of these questions about Pride and Prejudice.</Box>
                          <div className="center"><SupportPromptGroup
                            alignment="vertical"
                            ariaLabel="Sample questions"
                            items={SAMPLE_QUESTIONS}
                            onItemClick={({ detail }) => ask(SAMPLE_QUESTIONS.find((q) => q.id === detail.id)!.text)}
                          /></div>
                        </SpaceBetween>
                      </Box>
                    ) : (
                      <SpaceBetween size="m">
                        {turns.map((t) => (
                          <SpaceBetween size="m" key={t.id}>
                            <ChatBubble type="outgoing" ariaLabel="You" avatar={<Avatar ariaLabel="You" tooltipText="You" iconName="user-profile" />}>
                              {t.question}
                            </ChatBubble>
                            <ChatBubble
                              type="incoming"
                              ariaLabel="Assistant"
                              showLoadingBar={t.status === 'streaming'}
                              avatar={<Avatar color="gen-ai" iconName="gen-ai" ariaLabel="Assistant" tooltipText="Assistant" loading={t.status === 'streaming'} />}
                              actions={<TurnStatus turn={t} />}
                            >
                              {t.status === 'error' ? (
                                <StatusIndicator type="error">{t.error}</StatusIndicator>
                              ) : t.answer ? (
                                <div className="answer">
                                  {/* No images: a document could carry a remote image URL that leaks data. */}
                                  <ReactMarkdown disallowedElements={['img']}>{t.answer}</ReactMarkdown>
                                </div>
                              ) : (
                                <Box color="text-status-inactive">
                                  {t.searches.length ? 'Reading the passages' : 'Searching the books'}
                                </Box>
                              )}
                            </ChatBubble>
                          </SpaceBetween>
                        ))}
                        <div ref={endRef} />
                      </SpaceBetween>
                    )}
                  </div>
                </Container>

                <Container
                  header={
                    <Header variant="h2" counter={latest?.passages.length ? `(${latest.passages.length})` : undefined}
                      description="Passages the agent retrieved for the latest question">
                      Sources
                    </Header>
                  }
                >
                  <div className="sources">
                    {!latest?.passages.length ? (
                      <Box color="text-body-secondary" textAlign="center" padding="l">
                        {latest?.status === 'streaming' ? <StatusIndicator type="loading">Searching</StatusIndicator> : 'No passages yet'}
                      </Box>
                    ) : (
                      <SpaceBetween size="xs">
                        {ordered.map((p, i) => (
                          <ExpandableSection
                            variant="container"
                            key={`${p.id}-${quoted.has(p.id)}`}
                            defaultExpanded={quoted.size ? quoted.has(p.id) : i === 0}
                            headerText={`Passage ${i + 1}`}
                            headerActions={
                              <SpaceBetween direction="horizontal" size="xxs">
                                {quoted.has(p.id) && <Badge color="green">Quoted</Badge>}
                                <Badge color="grey">{p.score.toFixed(2)}</Badge>
                              </SpaceBetween>
                            }
                          >
                            <SpaceBetween size="xs">
                              <Box variant="small" color="text-body-secondary">{p.source}</Box>
                              <Box variant="p" fontSize="body-s"><span className="passage">{p.text}</span></Box>
                            </SpaceBetween>
                          </ExpandableSection>
                        ))}
                      </SpaceBetween>
                    )}
                  </div>
                </Container>
              </Grid>
            </SpaceBetween>
          </ContentLayout>
        }
      />
    </>
  );
}

function Detail({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box>{value ?? <StatusIndicator type="loading">Loading</StatusIndicator>}</Box>
    </div>
  );
}

function TurnStatus({ turn }: { turn: Turn }) {
  if (turn.status === 'streaming') {
    return <StatusIndicator type="loading">{turn.searches.length ? `Searched the books ${turn.searches.length}x` : 'Working'}</StatusIndicator>;
  }
  if (turn.status === 'error') return null;
  const parts = [
    `${turn.searches.length} ${turn.searches.length === 1 ? 'search' : 'searches'}`,
    `${turn.passages.length} passages`,
    turn.elapsedMs ? `${(turn.elapsedMs / 1000).toFixed(1)} s` : '',
    turn.tokens ? `${turn.tokens.toLocaleString()} tokens` : '',
  ].filter(Boolean);
  return <StatusIndicator type="success">{parts.join('  |  ')}</StatusIndicator>;
}

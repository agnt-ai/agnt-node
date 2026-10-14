/**
 * Anthropic: a fourth breakpoint at the previous request's tail (cacheTail.ts).
 *
 * Anthropic looks back at most 20 block positions from a breakpoint for an earlier cache write. The previous request
 * wrote its entry at its stable tail, which in this request is the newest stable message before the last assistant
 * turn; marking it again makes this request read the whole earlier conversation however much the newest turn added.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { anthropicMessageStream } from './_streamMocks.js';

const anthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { stream: anthropicStream } }; }),
}));

import AnthropicExecutor from '../providers/anthropic.js';
import type { BaseExecutorConfig, Message } from '../types.js';

function makeConfig(metadata?: Record<string, any>): BaseExecutorConfig {
  return {
    manifest: {
      kind: 'PromptManifest', apiVersion: 'v2', metadata: { name: 't', title: 't', description: '' },
      spec: { routingStrategy: 'fallback', enableToolCalls: true, variables: [], files: [], tools: [], dependencies: [],
        models: [{ provider: 'anthropic', model: 'claude-x', ...(metadata ? { metadata } : {}) }] },
    },
    credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent',
  } as any;
}

const RESP = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 } };
const TOOLS = [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }];
const SYSTEM: Message = { role: 'system', content: [{ type: 'text', text: 'STATIC', cacheBoundary: true }, { type: 'text', text: 'PER RUN' }] as any };
const note = (t: string): Message => ({ role: 'user', content: `clock ${t}`, releaseAfterRead: true });

/** The conversation after `turns` tool turns, with this turn's per-turn note last. */
function conversation(turns: number, parallel = 1): Message[] {
  const msgs: Message[] = [SYSTEM, { role: 'user', content: 'do the thing' }];
  for (let t = 1; t <= turns; t++) {
    const calls = Array.from({ length: parallel }, (_, i) => ({ id: `c${t}_${i}`, name: 'lookup', args: { i } }));
    msgs.push({ role: 'assistant', content: '', tool_calls: calls });
    for (const c of calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: `result ${c.id}` });
  }
  msgs.push(note(String(turns)));
  return msgs;
}

const marked = (block: any) => Boolean(block?.cache_control);
function marks(params: any): string[] {
  const out: string[] = [];
  if (Array.isArray(params.system)) params.system.forEach((b: any, i: number) => marked(b) && out.push(`system:${i}`));
  (params.tools ?? []).forEach((t: any, i: number) => marked(t) && out.push(`tools:${i}`));
  params.messages.forEach((m: any, i: number) => Array.isArray(m.content) && m.content.forEach((b: any, j: number) => marked(b) && out.push(`m${i}:${j}`)));
  return out;
}
/** The request with every cache_control removed and string content as a text block, for byte comparison. */
function unmarked(params: any): any {
  const strip = (b: any) => { const { cache_control: _c, ...rest } = b; return rest; };
  return {
    system: Array.isArray(params.system) ? params.system.map(strip) : params.system,
    tools: (params.tools ?? []).map(strip),
    messages: params.messages.map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(strip) })),
  };
}

beforeEach(() => { vi.clearAllMocks(); anthropicStream.mockImplementation(() => anthropicMessageStream(RESP)); });

describe('Anthropic earlier-tail breakpoint', () => {
  it('marks tools, the static system part, the stable tail and the previous tail: 4, never more', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(conversation(3), { tools: TOOLS });
    const params = anthropicStream.mock.calls[0][0];
    // messages: [0]=user, then per turn: assistant, tool_result; [7]=note
    expect(marks(params)).toEqual(['system:0', 'tools:0', 'm4:0', 'm6:0']);
    expect(params.messages[7].content).toBe('clock 3'); // the note stays unmarked (string, no block)
  });

  it('the previous request wrote at exactly the position this request marks as its earlier tail', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(conversation(2), { tools: TOOLS });
    await ex.invoke(conversation(3), { tools: TOOLS });
    const [prev, next] = [anthropicStream.mock.calls[0][0], anthropicStream.mock.calls[1][0]];
    const prevTail = marks(prev).filter(m => m.startsWith('m')).pop();
    expect(marks(next)).toContain(prevTail);
    // Byte-stable prefix: everything up to and including the previous tail is identical, markers aside.
    const a = unmarked(prev), b = unmarked(next);
    expect(b.system).toEqual(a.system);
    expect(b.tools).toEqual(a.tools);
    const upTo = Number(prevTail!.slice(1).split(':')[0]);
    expect(b.messages.slice(0, upTo + 1)).toEqual(a.messages.slice(0, upTo + 1));
  });

  it('a wide parallel turn (more than 20 new blocks) still reads the earlier conversation through the earlier tail', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(conversation(2, 25), { tools: TOOLS });
    const params = anthropicStream.mock.calls[0][0];
    const m = marks(params).filter(x => x.startsWith('m'));
    expect(m).toHaveLength(2);
    // the earlier tail is the last tool result of turn 1, before turn 2's assistant message
    const earlier = Number(m[0].slice(1).split(':')[0]);
    expect(params.messages[earlier + 1].role).toBe('assistant');
  });

  it('first turn (no assistant yet): no earlier tail', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke([SYSTEM, { role: 'user', content: 'hi' }, note('0')], { tools: TOOLS });
    expect(marks(anthropicStream.mock.calls[0][0])).toEqual(['system:0', 'tools:0', 'm0:0']);
  });

  it('kill switch (prompt_cache_breakpoints: false) drops only the earlier tail and never reaches the wire', async () => {
    const ex = new AnthropicExecutor(makeConfig({ prompt_cache_breakpoints: false, prompt_cache_key: 'lane' }));
    await ex.invoke(conversation(3), { tools: TOOLS });
    const params = anthropicStream.mock.calls[0][0];
    expect(marks(params)).toEqual(['system:0', 'tools:0', 'm6:0']);
    expect(params.prompt_cache_breakpoints).toBeUndefined();
    expect(params.prompt_cache_key).toBeUndefined();
  });

  it('a developer top-level cache_control takes a slot: no earlier tail', async () => {
    const ex = new AnthropicExecutor(makeConfig({ cache_control: { type: 'ephemeral' } }));
    await ex.invoke(conversation(3), { tools: TOOLS });
    expect(marks(anthropicStream.mock.calls[0][0])).toEqual(['system:0', 'tools:0', 'm6:0']);
  });

  it('disableCache: no marks at all', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(conversation(3), { tools: TOOLS, disableCache: true });
    expect(marks(anthropicStream.mock.calls[0][0])).toEqual([]);
  });

  it('never marks a thinking block or an empty text block', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    const msgs: Message[] = [SYSTEM, { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'text', text: '' }] as any }];
    await ex.invoke(msgs, { tools: TOOLS });
    const params = anthropicStream.mock.calls[0][0];
    expect(params.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages[0].content[1].cache_control).toBeUndefined();
  });

  it('reports reads and writes as reported (disjoint from input)', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    const res = await ex.invoke(conversation(1), { tools: TOOLS });
    expect(res.usage).toMatchObject({ input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 });
  });
});

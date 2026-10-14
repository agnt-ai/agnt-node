/**
 * Bedrock Converse prompt caching: Claude models get `cachePoint` blocks (tools, system static boundary, stable tail,
 * previous tail; 4 at most), every model's cache reads and writes are reported, and a model that rejects checkpoints
 * is retried once without them and left alone for 15 minutes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bedrockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function () { return { send: bedrockSend }; }),
  ConverseCommand: vi.fn().mockImplementation(function (params: any) { return { params }; }),
}));

import BedrockExecutor from '../bedrock.js';
import { resetBreakpointRejections } from '../openaiPromptCache.js';
import type { Message } from '../../types.js';

const CLAUDE = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

function makeExecutor(model = CLAUDE, metadata?: Record<string, any>) {
  return new BedrockExecutor({
    manifest: { kind: 'PromptManifest', apiVersion: 'v2', spec: { models: [{ provider: 'bedrock', model, ...(metadata ? { metadata } : {}) }], files: [], tools: [] } } as any,
    credentials: { bedrock: { region: 'us-east-2', accessKeyId: 'AK', secretAccessKey: 'SK' } },
    logLevel: 'silent',
  } as any);
}

const OK = { output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 900, cacheWriteInputTokens: 80 } };
const TOOLS = [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }];
const SYSTEM: Message = { role: 'system', content: [{ type: 'text', text: 'STATIC', cacheBoundary: true }, { type: 'text', text: 'PER RUN' }] as any };
const note = (t: string): Message => ({ role: 'user', content: `clock ${t}`, releaseAfterRead: true });

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

const sent = (i = 0) => bedrockSend.mock.calls[i][0].params;
function points(params: any): string[] {
  const out: string[] = [];
  (params.system ?? []).forEach((b: any, i: number) => b.cachePoint && out.push(`system:${i}`));
  (params.toolConfig?.tools ?? []).forEach((b: any, i: number) => b.cachePoint && out.push(`tools:${i}`));
  params.messages.forEach((m: any, i: number) => m.content.forEach((b: any, j: number) => b.cachePoint && out.push(`m${i}:${j}`)));
  return out;
}
const withoutPoints = (params: any) => ({
  system: (params.system ?? []).filter((b: any) => !b.cachePoint),
  tools: (params.toolConfig?.tools ?? []).filter((b: any) => !b.cachePoint),
  messages: params.messages.map((m: any) => ({ role: m.role, content: m.content.filter((b: any) => !b.cachePoint) })),
});

beforeEach(() => { vi.clearAllMocks(); resetBreakpointRejections(); bedrockSend.mockResolvedValue(OK); });

describe('Bedrock Claude cache checkpoints', () => {
  it('tools, static system boundary, stable tail, previous tail: 4 in all; the per-turn note stays after them', async () => {
    await makeExecutor().invoke(conversation(3), { tools: TOOLS });
    const p = sent();
    // system: [STATIC, cachePoint, PER RUN]; messages: [0]=user, [1]asst [2]results ... [6]results + the note (Converse
    // takes no two user messages in a row, so the note joins the results message, after the checkpoint)
    expect(points(p)).toEqual(['system:1', 'tools:1', 'm4:1', 'm6:1']);
    expect(p.system.map((b: any) => b.text ?? 'CP').join('|')).toBe('STATIC|CP|\n\nPER RUN');
    expect(p.messages).toHaveLength(7);
    expect(p.messages[6].content[2]).toEqual({ text: 'clock 3' });
    expect(p.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('the system text the model reads is unchanged by the split', async () => {
    await makeExecutor().invoke(conversation(1), { tools: TOOLS });
    expect(sent().system.filter((b: any) => b.text).map((b: any) => b.text).join('')).toBe('STATIC\n\nPER RUN');
  });

  it('the previous request\'s tail is this request\'s earlier tail, and the prefix up to it is byte-identical', async () => {
    const ex = makeExecutor();
    await ex.invoke(conversation(2), { tools: TOOLS });
    await ex.invoke(conversation(3), { tools: TOOLS });
    const [a, b] = [sent(0), sent(1)];
    const prevTail = points(a).filter(x => x.startsWith('m')).pop()!;
    expect(points(b)).toContain(prevTail);
    const [upTo, at] = prevTail.slice(1).split(':').map(Number);
    expect(withoutPoints(b).system).toEqual(withoutPoints(a).system);
    expect(withoutPoints(b).tools).toEqual(withoutPoints(a).tools);
    expect(withoutPoints(b).messages.slice(0, upTo)).toEqual(withoutPoints(a).messages.slice(0, upTo));
    // The checkpointed message itself: identical up to its checkpoint (the old note after it is gone).
    expect(b.messages[upTo].content.slice(0, at + 1)).toEqual(a.messages[upTo].content.slice(0, at + 1));
  });

  it('a parallel batch whose last result is read-once: no checkpoint inside the toolResult run; it moves to before the run', async () => {
    const msgs = conversation(2, 3);
    // turn 2's batch: c2_0, c2_1, c2_2 and a read-once result, then the note
    msgs.splice(msgs.length - 1, 0, { role: 'tool', tool_call_id: 'late', content: 'read once', releaseAfterRead: true });
    await makeExecutor().invoke(msgs, { tools: TOOLS });
    const p = sent();
    // messages: [0]user [1]asst(turn 1) [2]results(turn 1) [3]asst(turn 2) [4]results(turn 2) + late + note
    const shape = (m: any) => m.content.map((b: any) => (b.cachePoint ? 'CP' : b.toolResult?.toolUseId ?? b.toolUse?.toolUseId ?? b.text));
    expect(shape(p.messages[4])).toEqual(['c2_0', 'c2_1', 'c2_2', 'late', 'clock 2']);
    expect(shape(p.messages[3])).toEqual(['c2_0', 'c2_1', 'c2_2', 'CP']); // the tail mark, at the end of the assistant turn
    expect(shape(p.messages[2])).toEqual(['c1_0', 'c1_1', 'c1_2', 'CP']); // the previous tail: a whole run, untouched
    for (const m of p.messages) {
      const c = m.content;
      for (let i = 1; i + 1 < c.length; i++) expect(Boolean(c[i].cachePoint && c[i - 1].toolResult && c[i + 1].toolResult)).toBe(false);
    }
  });

  it('a checkpoint that would split a run that does not open its message moves to just before the run', async () => {
    const { outsideToolResultRun } = await import('../bedrock.js');
    const msgs = [{ role: 'user', content: [{ text: 'a' }, { toolResult: { toolUseId: 'x' } }, { toolResult: { toolUseId: 'y' } }] }];
    expect(outsideToolResultRun(msgs, [0, 2])).toEqual([0, 1]);
    expect(outsideToolResultRun(msgs, [0, 3])).toEqual([0, 3]);
    expect(outsideToolResultRun([{ role: 'user', content: [{ toolResult: {} }, { toolResult: {} }] }], [0, 1])).toBeNull();
  });

  it('string system prompt: the checkpoint goes after it', async () => {
    await makeExecutor().invoke([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], {});
    expect(sent().system).toEqual([{ text: 'SYS' }, { cachePoint: { type: 'default' } }]);
    expect(points(sent())).toEqual(['system:1', 'm0:1']);
  });

  it('no checkpoints: disableCache, the kill switch, Nova, DeepSeek, an old or Preview-caching Claude', async () => {
    await makeExecutor().invoke(conversation(2), { tools: TOOLS, disableCache: true });
    await makeExecutor(CLAUDE, { prompt_cache_breakpoints: false }).invoke(conversation(2), { tools: TOOLS });
    await makeExecutor('amazon.nova-pro-v1:0').invoke(conversation(2), { tools: TOOLS });
    await makeExecutor('deepseek.v3.2').invoke(conversation(2), { tools: TOOLS });
    await makeExecutor('anthropic.claude-3-opus-20240229-v1:0').invoke(conversation(2), { tools: TOOLS });
    await makeExecutor('anthropic.claude-3-5-sonnet-20241022-v2:0').invoke(conversation(2), { tools: TOOLS }); // Preview on Bedrock
    for (let i = 0; i < 6; i++) {
      expect(points(sent(i))).toEqual([]);
      expect(sent(i).system).toEqual([{ text: 'STATIC\n\nPER RUN' }]);
    }
  });

  it('reports cache reads and writes beside the uncached input (implicit caching included)', async () => {
    const res = await makeExecutor('amazon.nova-pro-v1:0').invoke(conversation(1), {});
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 80 });
    bedrockSend.mockResolvedValueOnce({ ...OK, usage: { inputTokens: 5, outputTokens: 1 } });
    const bare = await makeExecutor().invoke(conversation(1), {});
    expect(bare.usage).toEqual({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  it('a ValidationException with checkpoints is retried once without them; then they stay off for that model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bedrockSend.mockRejectedValueOnce(Object.assign(new Error('cachePoint not supported'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }));
    const ex = makeExecutor();
    const res = await ex.invoke(conversation(2), { tools: TOOLS });
    expect(res.message.content).toBe('ok');
    expect(points(sent(0)).length).toBe(4);
    expect(points(sent(1))).toEqual([]);
    expect(sent(1).system).toEqual([{ text: 'STATIC\n\nPER RUN' }]);
    await ex.invoke(conversation(2), { tools: TOOLS });
    expect(points(sent(2))).toEqual([]); // remembered
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a ValidationException that is not about checkpoints still fails (one retry, then the retry\'s error)', async () => {
    bedrockSend.mockRejectedValue(Object.assign(new Error('bad turn order'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }));
    await expect(makeExecutor().invoke(conversation(1), {})).rejects.toThrow('bad turn order');
    expect(bedrockSend).toHaveBeenCalledTimes(2);
  });

  it('a throttling error is not retried here', async () => {
    bedrockSend.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }));
    await expect(makeExecutor().invoke(conversation(1), {})).rejects.toThrow('slow down');
    expect(bedrockSend).toHaveBeenCalledTimes(1);
  });
});

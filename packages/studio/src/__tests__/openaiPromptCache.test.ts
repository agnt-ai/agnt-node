/**
 * GPT-5.6+ explicit prompt-cache breakpoints on the Responses path (providers/openaiPromptCache.ts), driven through
 * the real OpenAI and Azure Foundry executors with a recorded client.
 *
 * Prod 2026-10-13 (Azure gpt-6.1-sol): with no breakpoints the service ran in implicit mode, put its one breakpoint
 * on the latest message (the per-turn note), and every turn of a run read back the same 36,036-token opening prefix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAIResponsesStreamFromResponse } from './_streamMocks.js';

const responsesCreate = vi.fn();
const chatCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return {
    chat: { completions: { create: chatCreate } },
    responses: { create: responsesCreate },
  }; }),
}));

import OpenAIExecutor from '../providers/openai.js';
import AzureFoundryExecutor from '../providers/azureFoundry.js';
import {
  breakpointIndexes, placeConversationBreakpoints, resetBreakpointRejections, supportsPromptCacheBreakpoints, PROMPT_CACHE_BREAKPOINT_SUPPORT,
} from '../providers/openaiPromptCache.js';
import { SYSTEM_PART_SEPARATOR } from '../providers/systemContent.js';
import * as pkg from '../index.js';
import type { Message } from '../types.js';

const BP = { mode: 'explicit' };

function config(provider: string, model: string, metadata: Record<string, any> = {}) {
  return {
    manifest: { kind: 'PromptManifest', apiVersion: 'v2', metadata: { name: 't' }, spec: { models: [{ provider, model, metadata }], files: [], tools: [] } },
    credentials: { openai: { apiKey: 'k' }, azureFoundry: { apiKey: 'k', endpoint: 'https://res.services.ai.azure.com/openai/v1' } },
    logLevel: 'silent',
  } as any;
}

let call = 0;
/** Each response makes one tool call with a reasoning item, like a Prime turn. */
function stubToolTurns(usage: Record<string, any> = { input_tokens: 10, output_tokens: 5 }) {
  responsesCreate.mockImplementation(async () => {
    call += 1;
    return openAIResponsesStreamFromResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', id: `rs_${call}`, summary: [], encrypted_content: `enc${call}` },
        { type: 'function_call', id: `fc_${call}`, call_id: `call_${call}`, name: 'progress', arguments: `{"step":${call}}` },
      ],
      usage,
    });
  });
}

const STATIC = 'S'.repeat(3000);
const system = (): Message => ({ role: 'system', content: [{ type: 'text', text: STATIC, cacheBoundary: true }, { type: 'text', text: 'per-run clock 09:00' }] });
const note = (turn: number): Message => ({ role: 'user', content: `Communication timing context (guidance): turn ${turn}`, releaseAfterRead: true } as Message);

/** Run `turns` requests the way runPrime does: the newest assistant turn and its results appended, the per-turn
 *  note replaced and kept last. Returns the input each request sent. */
async function runLoop(ex: any, turns: number, opts: Record<string, any> = {}) {
  const transcript: Message[] = [system(), { role: 'user', content: 'Do the research and report back.' }];
  const sent: any[][] = [];
  for (let t = 1; t <= turns; t++) {
    const res = await ex.invoke([...transcript, note(t)], opts);
    sent.push(responsesCreate.mock.lastCall![0].input);
    transcript.push(res.message);
    for (const tc of res.message.tool_calls) transcript.push({ role: 'tool', tool_call_id: tc.id, content: `result ${tc.id} `.repeat(40) });
  }
  return sent;
}

const json = (x: any) => JSON.stringify(x);
const lastAssistantItem = (input: any[]) => input.reduce((at, item, i) => (['reasoning', 'function_call'].includes(item?.type) || item?.role === 'assistant' ? i : at), -1);

beforeEach(() => {
  vi.clearAllMocks();
  resetBreakpointRejections();
  call = 0;
});

describe('which models get breakpoints', () => {
  it('GPT-5.6 and later families only', () => {
    for (const m of ['gpt-5.6', 'gpt-5.6-luna', 'gpt-5.10', 'gpt-6', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-7.2-mini']) expect(supportsPromptCacheBreakpoints(m), m).toBe(true);
    for (const m of ['gpt-5', 'gpt-5.4', 'gpt-5.5-pro', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-4o', 'gpt-4.1', '', 'llama-4']) expect(supportsPromptCacheBreakpoints(m), m).toBe(false);
  });

  it('the package says it places them', () => {
    expect((pkg as any).PROMPT_CACHE_BREAKPOINT_SUPPORT).toBe(PROMPT_CACHE_BREAKPOINT_SUPPORT);
  });
});

describe.each([['openai', OpenAIExecutor], ['azureFoundry', AzureFoundryExecutor]] as const)('%s Responses breakpoints', (provider, Executor) => {
  it('explicit mode; static system part, earlier tails and the stable tail carry breakpoints; the trailing note does not', async () => {
    stubToolTurns();
    const sent = await runLoop(new Executor(config(provider, 'gpt-6.1-sol')), 3);
    const params = responsesCreate.mock.lastCall![0];
    expect(params.prompt_cache_options).toEqual({ mode: 'explicit' });
    const input = sent[2];

    // The system message: one block per part, the model reads exactly the joined text, the breakpoint on the static part.
    expect(input[0]).toEqual({ role: 'system', content: [
      { type: 'input_text', text: STATIC, prompt_cache_breakpoint: BP },
      { type: 'input_text', text: `${SYSTEM_PART_SEPARATOR}per-run clock 09:00` },
    ] });

    // The note is last and unmarked; the stable tail (newest function_call_output) is marked as an input_text array.
    const last = input.at(-1);
    expect(last.content).toBe('Communication timing context (guidance): turn 3');
    const tail = input.at(-2);
    expect(tail).toMatchObject({ type: 'function_call_output', call_id: 'call_2' });
    expect(tail.output).toEqual([{ type: 'input_text', text: 'result call_2 '.repeat(40), prompt_cache_breakpoint: BP }]);

    // Every earlier tail is marked: the opening user message (request 1's tail) and call_1's output (request 2's).
    const marked = breakpointIndexes(input).map(i => input[i]);
    expect(marked.map(item => item.call_id ?? item.role)).toEqual(['system', 'user', 'call_1', 'call_2']);
    // Reasoning and function_call items are replayed untouched.
    expect(input.filter((i: any) => i.type === 'reasoning').map((i: any) => i.id)).toEqual(['rs_1', 'rs_2']);
  });

  it('each request is the previous one minus its note plus the new turn, byte for byte (breakpoints included)', async () => {
    stubToolTurns();
    const sent = await runLoop(new Executor(config(provider, 'gpt-6.1-sol')), 5);
    for (let t = 1; t < sent.length; t++) {
      const prev = sent[t - 1].slice(0, -1); // minus the trailing note
      expect(json(sent[t].slice(0, prev.length)), `request ${t + 1}`).toBe(json(prev));
      // The previous request's tail breakpoint is still there, so this request can read what that one wrote.
      expect(breakpointIndexes(sent[t])).toContain(prev.length - 1);
    }
  });

  it('never more than four write candidates: only breakpoints after the newest assistant output are new', async () => {
    stubToolTurns();
    const sent = await runLoop(new Executor(config(provider, 'gpt-6.1-sol')), 30);
    expect(breakpointIndexes(sent[0])).toEqual([0, 1]); // the static system part and the opening user message (the tail); the note is unmarked
    for (const input of sent) {
      const after = lastAssistantItem(input);
      const fresh = breakpointIndexes(input).filter(i => i > after);
      expect(fresh.length).toBeLessThanOrEqual(4);
      expect(fresh.length).toBeGreaterThanOrEqual(1);
    }
    // In a long run only the tail is new; the newest earlier tail (what this turn reads) is within the latest 50.
    const input = sent.at(-1)!;
    const bps = breakpointIndexes(input);
    expect(bps.filter(i => i > lastAssistantItem(input))).toHaveLength(1);
    expect(bps.slice(-50)).toContain(bps.at(-2));
  });

  it('trailing releaseAfterRead results stay after the tail breakpoint', async () => {
    stubToolTurns();
    const ex = new Executor(config(provider, 'gpt-6.1-sol'));
    await ex.invoke([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'peek', args: {} }] },
      { role: 'tool', tool_call_id: 'a', content: 'kept' },
      { role: 'tool', tool_call_id: 'b', content: 'read once', releaseAfterRead: true } as Message,
      note(1),
    ]);
    const input = responsesCreate.mock.lastCall![0].input;
    const outputs = input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs[0].output).toEqual([{ type: 'input_text', text: 'kept', prompt_cache_breakpoint: BP }]);
    expect(outputs[1].output).toBe('read once');
    expect(input[0].content).toEqual([{ type: 'input_text', text: 'sys', prompt_cache_breakpoint: BP }]);
  });

  it('disableCache (one-shot callers): only the static system part is marked', async () => {
    stubToolTurns();
    await new Executor(config(provider, 'gpt-6.1-sol')).invoke([system(), { role: 'user', content: 'one shot' }], { disableCache: true });
    const params = responsesCreate.mock.lastCall![0];
    expect(params.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(breakpointIndexes(params.input)).toEqual([0]);
    expect(params.input[1]).toEqual({ role: 'user', content: 'one shot' });
  });

  it('older models are untouched: no breakpoint, no prompt_cache_options, system parts joined', async () => {
    for (const model of ['gpt-5.4', 'gpt-5', 'o3']) {
      responsesCreate.mockClear();
      stubToolTurns();
      await runLoop(new Executor(config(provider, model)), 2);
      for (const [params] of responsesCreate.mock.calls) {
        expect(params.prompt_cache_options, model).toBeUndefined();
        expect(json(params), model).not.toContain('prompt_cache_breakpoint');
        expect(params.input[0], model).toEqual({ role: 'system', content: `${STATIC}${SYSTEM_PART_SEPARATOR}per-run clock 09:00` });
      }
    }
  });

  it('metadata prompt_cache_breakpoints:false turns them off and is not sent', async () => {
    stubToolTurns();
    await runLoop(new Executor(config(provider, 'gpt-6.1-sol', { prompt_cache_breakpoints: false })), 2);
    const params = responsesCreate.mock.lastCall![0];
    expect(params.prompt_cache_breakpoints).toBeUndefined();
    expect(params.prompt_cache_options).toBeUndefined();
    expect(json(params)).not.toContain('prompt_cache_breakpoint');
  });

  it('a developer-set prompt_cache_options wins', async () => {
    stubToolTurns();
    await new Executor(config(provider, 'gpt-6.1-sol', { prompt_cache_options: { mode: 'implicit', ttl: '30m' } })).invoke([{ role: 'user', content: 'hi' }]);
    expect(responsesCreate.mock.lastCall![0].prompt_cache_options).toEqual({ mode: 'implicit', ttl: '30m' });
  });

  it('a 400 naming the parameters retries once without them and stops sending them for that model', async () => {
    let n = 0;
    responsesCreate.mockImplementation(async (params: any) => {
      n += 1;
      if (params.prompt_cache_options) {
        const err: any = new Error("400 Unknown parameter: 'prompt_cache_options'.");
        err.status = 400;
        throw err;
      }
      return openAIResponsesStreamFromResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `ok ${n}` }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const ex = new Executor(config(provider, 'gpt-6.1-sol'));
    expect((await ex.invoke([{ role: 'user', content: 'hi' }])).message.content).toBe('ok 2');
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(json(responsesCreate.mock.calls[1][0])).not.toContain('prompt_cache');
    await ex.invoke([{ role: 'user', content: 'again' }]);
    expect(responsesCreate).toHaveBeenCalledTimes(3);
    expect(responsesCreate.mock.calls[2][0].prompt_cache_options).toBeUndefined();
  });

  it('any other 400 is not retried', async () => {
    responsesCreate.mockImplementation(async () => { const err: any = new Error('400 Invalid tool schema'); err.status = 400; throw err; });
    await expect(new Executor(config(provider, 'gpt-6.1-sol')).invoke([{ role: 'user', content: 'hi' }])).rejects.toThrow('Invalid tool schema');
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('cache writes come back as cacheCreation, disjoint from reads and fresh input', async () => {
    stubToolTurns({ input_tokens: 50_000, output_tokens: 10, input_tokens_details: { cached_tokens: 36_036, cache_write_tokens: 12_000 } });
    const res = await new Executor(config(provider, 'gpt-6.1-sol')).invoke([{ role: 'user', content: 'hi' }]);
    expect(res.usage).toMatchObject({ input_tokens: 1_964, cache_read_input_tokens: 36_036, cache_creation_input_tokens: 12_000, output_tokens: 10 });
  });
});

describe('placeConversationBreakpoints (pure)', () => {
  it('a tail that is an assistant turn leaves only the earlier tail marked', () => {
    const messages: Message[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    const groups = [[{ role: 'user', content: 'q' }], [{ role: 'assistant', content: [{ type: 'output_text', text: 'a' }] }]];
    const input = placeConversationBreakpoints(messages, groups, { cacheOn: true });
    expect(breakpointIndexes(input)).toEqual([0]);
  });

  it('does not mutate the caller groups', () => {
    const item = { type: 'function_call_output', call_id: 'c', output: 'x' };
    const messages: Message[] = [{ role: 'tool', tool_call_id: 'c', content: 'x' }];
    placeConversationBreakpoints(messages, [[item]], { cacheOn: true });
    expect(item.output).toBe('x');
  });
});

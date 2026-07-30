/**
 * OpenAIExecutor reasoning-family routing (the /v1/responses path).
 *
 * OpenAI's reasoning family (o1/o3/o4, gpt-5.x) is served over the Responses
 * API, NOT Chat Completions: Chat Completions hard-400s the one combination
 * these models are used for here — function tools + reasoning_effort ("Function
 * tools with reasoning_effort are not supported ... in /v1/chat/completions. To
 * use function tools, use /v1/responses or set reasoning_effort to 'none'").
 *
 * These tests pin the routing + request-shape translation:
 *   - reasoning-family models call responses.create (not chat.completions)
 *   - reasoning_effort -> reasoning.effort, verbosity -> text.verbosity,
 *     max_tokens/max_completion_tokens -> max_output_tokens
 *   - legacy sampling params (temperature/top_p/...) are stripped (rejected)
 *   - tools are flattened to the Responses shape and tool history is replayed
 *     as function_call / function_call_output items
 *   - non-reasoning models (gpt-4o) stay on the Chat Completions path untouched
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAIStreamFromCompletion, openAIResponsesStreamFromResponse } from './_streamMocks.js';

const openaiChatCreate = vi.fn();
const openaiResponsesCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiChatCreate } },
    responses: { create: openaiResponsesCreate },
  })),
}));

import OpenAIExecutor from '../providers/openai.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function makeManifest(provider: string, model: string, metadata: Record<string, any>): PromptManifestV2 {
  return {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest',
    apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: {
      routingStrategy: 'fallback',
      enableToolCalls: false,
      variables: [],
      files: [],
      tools: [],
      models: [{ provider, model, metadata }],
      dependencies: [],
    },
  };
}

function makeConfig(provider: string, model: string, metadata: Record<string, any>): BaseExecutorConfig {
  return {
    manifest: makeManifest(provider, model, metadata),
    credentials: { openai: { apiKey: 'k' } },
    logLevel: 'silent',
  } as BaseExecutorConfig;
}

/** Canned terminal Response: one assistant text message + usage. */
function stubResponses(overrides?: { output?: any[]; usage?: any }) {
  openaiResponsesCreate.mockImplementation(async () =>
    openAIResponsesStreamFromResponse({
      status: 'completed',
      output: overrides?.output ?? [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      ],
      usage: overrides?.usage ?? { input_tokens: 10, output_tokens: 5 },
    })
  );
}

function stubChat() {
  openaiChatCreate.mockImplementation(async () =>
    openAIStreamFromCompletion({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenAIExecutor reasoning-family routing (/v1/responses)', () => {
  it('routes gpt-5.x to responses.create, not chat.completions', async () => {
    stubResponses();
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-5.6', { reasoning_effort: 'high' }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(openaiResponsesCreate).toHaveBeenCalledTimes(1);
    expect(openaiChatCreate).not.toHaveBeenCalled();
  });

  it('routes o1/o3/o4 to responses.create', async () => {
    for (const model of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini']) {
      stubResponses();
      const ex = new OpenAIExecutor(makeConfig('openai', model, { max_tokens: 2048 }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);

      expect(openaiResponsesCreate).toHaveBeenCalledTimes(1);
      expect(openaiChatCreate).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('translates reasoning_effort -> reasoning.effort and verbosity -> text.verbosity', async () => {
    stubResponses();
    const ex = new OpenAIExecutor(
      makeConfig('openai', 'gpt-5.6', { reasoning_effort: 'high', verbosity: 'low' })
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = openaiResponsesCreate.mock.calls[0][0];
    expect(sent.reasoning).toEqual({ effort: 'high' });
    expect(sent.text).toEqual({ verbosity: 'low' });
    // The flat metadata keys must NOT survive as top-level params (they'd 400).
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.verbosity).toBeUndefined();
  });

  it('maps max_tokens / max_completion_tokens -> max_output_tokens', async () => {
    stubResponses();
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-5.6', { max_tokens: 4096 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    let sent = openaiResponsesCreate.mock.calls[0][0];
    expect(sent.max_output_tokens).toBe(4096);
    expect(sent.max_tokens).toBeUndefined();
    vi.clearAllMocks();

    stubResponses();
    const ex2 = new OpenAIExecutor(makeConfig('openai', 'gpt-5.6', { max_completion_tokens: 2048 }));
    await ex2.invoke([{ role: 'user', content: 'hi' }]);
    sent = openaiResponsesCreate.mock.calls[0][0];
    expect(sent.max_output_tokens).toBe(2048);
    expect(sent.max_completion_tokens).toBeUndefined();
  });

  it('strips legacy sampling params (temperature/top_p/...) from the Responses request', async () => {
    stubResponses();
    const ex = new OpenAIExecutor(
      makeConfig('openai', 'gpt-5.6', {
        temperature: 0.7,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
      })
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = openaiResponsesCreate.mock.calls[0][0];
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
    expect(sent.frequency_penalty).toBeUndefined();
    expect(sent.presence_penalty).toBeUndefined();
  });

  it('sends the conversation as input items and flattens tools to the Responses shape', async () => {
    stubResponses();
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-5.6', {}));
    await ex.invoke(
      [
        { role: 'user', content: 'find x' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'search', args: { q: 'x' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"result":"ok"}' },
      ],
      { tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } }] }
    );

    const sent = openaiResponsesCreate.mock.calls[0][0];
    // input carries the user message, a function_call, and its function_call_output.
    const fc = sent.input.find((i: any) => i.type === 'function_call');
    const out = sent.input.find((i: any) => i.type === 'function_call_output');
    expect(fc).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'search' });
    expect(JSON.parse(fc.arguments)).toEqual({ q: 'x' });
    expect(out).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: '{"result":"ok"}' });
    // Tool is flat (name/parameters at top level, no nested `function`).
    expect(sent.tools[0]).toMatchObject({ type: 'function', name: 'search' });
    expect(sent.tools[0].function).toBeUndefined();
    expect(sent.parallel_tool_calls).toBe(true);
  });

  it('maps Responses output (text + function_call) and usage back into InvokeResult', async () => {
    stubResponses({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'here you go' }] },
        { type: 'function_call', call_id: 'call_9', name: 'book', arguments: '{"when":"noon"}' },
      ],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
    });
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-5.6', {}));
    const res = await ex.invoke([{ role: 'user', content: 'book noon' }]);

    expect(res.message.content).toBe('here you go');
    expect(res.message.tool_calls).toEqual([{ id: 'call_9', name: 'book', args: { when: 'noon' } }]);
    // input_tokens is UNCACHED (100 - 30); cached tokens land in cache_read.
    expect(res.usage).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    });
  });

  it('leaves non-reasoning models (gpt-4o) on the Chat Completions path untouched', async () => {
    stubChat();
    const ex = new OpenAIExecutor(
      makeConfig('openai', 'gpt-4o', { max_tokens: 4096, temperature: 0.7 })
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(openaiChatCreate).toHaveBeenCalledTimes(1);
    expect(openaiResponsesCreate).not.toHaveBeenCalled();
    const sent = openaiChatCreate.mock.calls[0][0];
    expect(sent.max_tokens).toBe(4096);
    expect(sent.temperature).toBe(0.7);
  });

  it('does not misclassify gpt-4o-mini as reasoning-family', async () => {
    stubChat();
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o-mini', { max_tokens: 1024 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(openaiChatCreate).toHaveBeenCalledTimes(1);
    expect(openaiResponsesCreate).not.toHaveBeenCalled();
  });
});

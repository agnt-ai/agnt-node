/**
 * Provider adapter STREAMING tests.
 *
 * Proves each adapter (Anthropic / OpenAI / Google) consumes a token STREAM and
 * assembles the SAME InvokeResult shape the non-streamed path produced:
 *   - text content concatenated
 *   - tool_use / tool_call deltas accumulated into complete calls (args parsed)
 *   - usage captured from the final stream event
 *   - the caller's AbortSignal is respected (external abort → invoke rejects)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  anthropicMessageStream,
  openAIToolCallStream,
  openAIStreamFromCompletion,
  googleStreamResult,
} from './_streamMocks.js';

const anthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { stream: anthropicStream } })),
}));

const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: openaiCreate } } })),
}));

const googleGenerateContentStream = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContentStream: googleGenerateContentStream }),
  })),
}));

import AnthropicExecutor from '../providers/anthropic.js';
import OpenAIExecutor from '../providers/openai.js';
import GoogleExecutor from '../providers/google.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function makeConfig(provider: string, model: string, creds: any): BaseExecutorConfig {
  const manifest: PromptManifestV2 = {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest',
    apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: {
      routingStrategy: 'fallback', enableToolCalls: false,
      variables: [], files: [], tools: [], models: [{ provider, model }], dependencies: [],
    },
  };
  return { manifest, credentials: creds, logLevel: 'silent' } as BaseExecutorConfig;
}

beforeEach(() => vi.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicExecutor streaming', () => {
  it('assembles text + tool_use + usage from finalMessage()', async () => {
    anthropicStream.mockReturnValue(
      anthropicMessageStream({
        content: [
          { type: 'text', text: 'Looking that up' },
          { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'widgets' } },
        ],
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      })
    );

    const ex = new AnthropicExecutor(makeConfig('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }], { tools: [{ name: 'search', description: 'd', parameters: { type: 'object', properties: {} } }] as any });

    expect(res.message.content).toBe('Looking that up');
    expect(res.message.tool_calls).toEqual([{ id: 'tu_1', name: 'search', args: { q: 'widgets' } }]);
    expect(res.usage).toEqual({
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2,
    });
  });

  it('bumps the idle timer on every stream event', async () => {
    const streamObj = anthropicMessageStream(
      { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
      [{ type: 'message_start' }, { type: 'content_block_delta' }, { type: 'message_delta' }]
    );
    const onSpy = vi.spyOn(streamObj, 'on');
    anthropicStream.mockReturnValue(streamObj);

    const ex = new AnthropicExecutor(makeConfig('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    // The adapter subscribes to streamEvent to reset the idle timer.
    expect(onSpy).toHaveBeenCalledWith('streamEvent', expect.any(Function));
  });

  it('rejects promptly when the caller signal is already aborted', async () => {
    anthropicStream.mockReturnValue(anthropicMessageStream({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = new AnthropicExecutor(makeConfig('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    const ac = new AbortController();
    ac.abort();
    await expect(ex.invoke([{ role: 'user', content: 'hi' }], { signal: ac.signal } as any)).rejects.toThrow();
    expect(anthropicStream).not.toHaveBeenCalled(); // aborted before the attempt
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAIExecutor streaming', () => {
  it('accumulates tool_call argument deltas and parses them into args', async () => {
    openaiCreate.mockImplementation(async () =>
      openAIToolCallStream('call_9', 'lookup', '{"id":42,"deep":{"k":"v"}}', { prompt_tokens: 8, completion_tokens: 4 })
    );

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }], { tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }] as any });

    expect(res.message.tool_calls).toEqual([{ id: 'call_9', name: 'lookup', args: { id: 42, deep: { k: 'v' } } }]);
    expect(res.usage.input_tokens).toBe(8);
    expect(res.usage.output_tokens).toBe(4);
  });

  it('does not crash on a tool call that streams no arguments (defaults to {})', async () => {
    // A zero-arg tool call from an OpenAI-compatible endpoint (DeepSeek/Together/
    // Kimi/Qwen) may omit the arguments fragment entirely. Must parse to {}, not
    // throw JSON.parse("").
    async function* noArgToolStream() {
      yield { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ping' } }] } }] };
      yield { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } };
    }
    openaiCreate.mockImplementation(async () => noArgToolStream());

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }], { tools: [{ name: 'ping', description: 'd', parameters: { type: 'object', properties: {} } }] as any });

    expect(res.message.tool_calls).toEqual([{ id: 'c1', name: 'ping', args: {} }]);
  });

  it('assembles streamed text content', async () => {
    openaiCreate.mockImplementation(async () =>
      openAIStreamFromCompletion({
        choices: [{ message: { role: 'assistant', content: 'streamed reply' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })
    );

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(res.message.content).toBe('streamed reply');
    expect(res.usage.output_tokens).toBe(2);
  });

  it('requests usage on the stream (stream_options.include_usage)', async () => {
    openaiCreate.mockImplementation(async () =>
      openAIStreamFromCompletion({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    );
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const params = openaiCreate.mock.calls[0][0];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Google
// ─────────────────────────────────────────────────────────────────────────────

describe('GoogleExecutor streaming', () => {
  it('assembles text + functionCall + usage from the aggregated response', async () => {
    googleGenerateContentStream.mockResolvedValue(
      googleStreamResult({
        candidates: [{ content: { parts: [{ text: 'here' }, { functionCall: { name: 'geo', args: { city: 'NYC' } } }] } }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12 },
      })
    );

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }], { tools: [{ name: 'geo', description: 'd', parameters: { type: 'object', properties: {} } }] as any });

    expect(res.message.content).toBe('here');
    expect(res.message.tool_calls).toEqual([{ id: 'geo', name: 'geo', args: { city: 'NYC' } }]);
    expect(res.usage.input_tokens).toBe(30);
    expect(res.usage.output_tokens).toBe(12);
  });

  it('preserves thoughtSignature in rawParts from the raw stream chunks (aggregate strips it)', async () => {
    // The SDK's response aggregator drops thought/thoughtSignature, so the
    // aggregated candidate parts (what `result.response` returns) have none.
    const aggregated = {
      candidates: [{ content: { parts: [{ text: 'answer' }, { functionCall: { name: 'geo', args: { city: 'NYC' } } }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
    };
    // The raw stream chunk still carries the signed thought part.
    const rawChunk = {
      candidates: [{ content: { parts: [
        { text: 'thinking', thought: true, thoughtSignature: 'SIG_ABC123' },
        { functionCall: { name: 'geo', args: { city: 'NYC' } } },
      ] } }],
    };
    googleGenerateContentStream.mockResolvedValue(googleStreamResult(aggregated, [rawChunk]));

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.5-pro', { google: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }], { tools: [{ name: 'geo', description: 'd', parameters: { type: 'object', properties: {} } }] as any });

    // rawParts must retain the signature so it can be echoed back next turn.
    const thoughtPart = (res.message.rawParts as any[]).find((p) => p.thought);
    expect(thoughtPart?.thoughtSignature).toBe('SIG_ABC123');
    // Content/toolCalls still come from the aggregate — unaffected.
    expect(res.message.content).toBe('answer');
    expect(res.message.tool_calls).toEqual([{ id: 'geo', name: 'geo', args: { city: 'NYC' } }]);
  });

  it('passes the abort signal into generateContentStream', async () => {
    googleGenerateContentStream.mockResolvedValue(
      googleStreamResult({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })
    );
    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const reqOpts = googleGenerateContentStream.mock.calls[0][1];
    expect(reqOpts.signal).toBeInstanceOf(AbortSignal);
  });
});

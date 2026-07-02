/**
 * OpenAICompatibleExecutor tests.
 *
 * This shared adapter serves every OpenAI-compatible host (Together, Fireworks,
 * DeepInfra, DeepSeek, …). Things it MUST get right for the Kimi/Qwen
 * cost/quality experiment:
 *
 *  1. Capture automatic cache-read tokens from usage — nested
 *     prompt_tokens_details.cached_tokens OR top-level cached_tokens (Together's
 *     OpenAI-compat surface uses the latter; some hosts omit the nested object).
 *     A missed field reads as 0% hit rate → ~5x cost on our cache-heavy
 *     workload, and fails silently — the highest-risk defect class here.
 *  2. Resolve baseURL + credentials from CONFIG (registry / creds / model
 *     metadata), so adding a provider is config-only, no new code.
 *  3. STREAM the response with an idle timeout (shared streaming.ts) so a long
 *     multi-tool Kimi turn never races a total-completion timeout, and still
 *     reassembles back to the exact non-streamed shape (usage + tool args).
 *
 * invoke() streams, so every response mock is a chunk stream built with the
 * shared _streamMocks helpers (same as providerStreaming.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAIStreamFromCompletion, openAIToolCallStream } from './_streamMocks.js';

// Capture the OpenAI client constructor args so we can assert baseURL/apiKey,
// and the create() args so we can assert stream options / param passthrough.
const openaiCreate = vi.fn();
const openaiCtor = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((opts: any) => {
    openaiCtor(opts);
    return { chat: { completions: { create: openaiCreate } } };
  }),
}));

import OpenAICompatibleExecutor, {
  OPENAI_COMPATIBLE_BASE_URLS,
} from '../providers/openaiCompatible.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function makeManifest(provider: string, model: string, metadata?: Record<string, any>): PromptManifestV2 {
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
      models: [{ provider, model, ...(metadata ? { metadata } : {}) }],
      dependencies: [],
    },
  };
}

function makeConfig(provider: string, model: string, creds: any, metadata?: Record<string, any>): BaseExecutorConfig {
  return {
    manifest: makeManifest(provider, model, metadata),
    credentials: creds,
    logLevel: 'silent',
  } as BaseExecutorConfig;
}

/** Set the streamed response the mocked client returns for the next invoke(). */
function mockStream(completion: any) {
  openaiCreate.mockImplementation(async () => openAIStreamFromCompletion(completion));
}

beforeEach(() => vi.clearAllMocks());

describe('OpenAICompatibleExecutor — cache-read capture (Together / Kimi)', () => {
  it('captures cached_tokens and subtracts them from prompt_tokens (disjoint buckets)', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 750_000, // INCLUDES the 740k cached (heavy-cache workload)
        completion_tokens: 4_500,
        prompt_tokens_details: { cached_tokens: 740_000 },
      },
    });

    const ex = new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }),
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(10_000); // 750k - 740k uncached
    expect(usage.cache_read_input_tokens).toBe(740_000);
    // Automatic-cache providers have no billed write concept → 0 (backend maps
    // to null / "—" from the model's cacheMode, not from this integer).
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(4_500);
    // Inclusive total is recovered by summation — no double count.
    expect(usage.input_tokens! + usage.cache_read_input_tokens!).toBe(750_000);
  });

  it('captures a TOP-LEVEL usage.cached_tokens (Together OpenAI-compat shape, no prompt_tokens_details)', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 500_000,
        completion_tokens: 2_000,
        cached_tokens: 480_000, // top-level, NOT nested under prompt_tokens_details
      },
    });

    const ex = new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }),
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.cache_read_input_tokens).toBe(480_000);
    expect(usage.input_tokens).toBe(20_000); // 500k - 480k
  });

  it('prefers the nested prompt_tokens_details.cached_tokens when both are present', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 1,
        cached_tokens: 999, // stale/duplicate top-level
        prompt_tokens_details: { cached_tokens: 60 },
      },
    });

    const ex = new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }),
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.cache_read_input_tokens).toBe(60);
    expect(usage.input_tokens).toBe(40);
  });

  it('captures DeepSeek-style prompt_cache_hit_tokens', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10_000, completion_tokens: 200, prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000 },
    });

    const ex = new OpenAICompatibleExecutor(
      makeConfig('deepseek', 'deepseek-chat', { deepseek: { apiKey: 'k' } }),
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.cache_read_input_tokens).toBe(9_000);
    expect(usage.input_tokens).toBe(1_000); // 10k - 9k uncached
  });

  it('reports 0 cache reads when the provider returns no cached_tokens (cold prefix)', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 8_000, completion_tokens: 100 },
    });

    const ex = new OpenAICompatibleExecutor(
      makeConfig('together', 'Qwen/Qwen3.5-9B', { together: { apiKey: 'k' } }),
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(8_000);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
  });

  it('clamps input_tokens to 0 if cached_tokens exceeds prompt_tokens', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 250 } },
    });

    const ex = new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }),
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(250);
  });
});

describe('OpenAICompatibleExecutor — streaming', () => {
  it('requests streamed usage (stream:true + stream_options.include_usage)', async () => {
    mockStream({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const ex = new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const params = openaiCreate.mock.calls[0][0];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    // Idle-abort signal is threaded to the client call (second arg).
    expect(openaiCreate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('translates an Anthropic-shaped tool_choice into OpenAI format', async () => {
    mockStream({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const ex = new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }));
    await ex.invoke(
      [{ role: 'user', content: 'hi' }],
      { tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }] as any,
        tool_choice: { type: 'tool', name: 'lookup' } as any },
    );
    // { type:'tool', name } (Anthropic) → { type:'function', function:{ name } } (OpenAI).
    expect(openaiCreate.mock.calls[0][0].tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
  });

  it('accumulates fragmented tool_call argument deltas back into parsed args', async () => {
    openaiCreate.mockImplementation(async () =>
      openAIToolCallStream('call_9', 'lookup', '{"id":42,"deep":{"k":"v"}}', { prompt_tokens: 8, completion_tokens: 4 }),
    );
    const ex = new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }));
    const res = await ex.invoke(
      [{ role: 'user', content: 'hi' }],
      { tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }] as any },
    );

    expect(res.message.tool_calls).toEqual([{ id: 'call_9', name: 'lookup', args: { id: 42, deep: { k: 'v' } } }]);
    expect(res.usage!.input_tokens).toBe(8);
    expect(res.usage!.output_tokens).toBe(4);
  });

  it('does not crash on a Kimi/Qwen zero-arg tool call (defaults arguments to {})', async () => {
    async function* noArgToolStream() {
      yield { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ping' } }] } }] };
      yield { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } };
    }
    openaiCreate.mockImplementation(async () => noArgToolStream());
    const ex = new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }));
    const res = await ex.invoke(
      [{ role: 'user', content: 'hi' }],
      { tools: [{ name: 'ping', description: 'd', parameters: { type: 'object', properties: {} } }] as any },
    );

    expect(res.message.tool_calls).toEqual([{ id: 'c1', name: 'ping', args: {} }]);
  });

  it('does not crash when the host omits usage on the final chunk (yields 0s, not a throw)', async () => {
    // Some OpenAI-compatible hosts ignore stream_options.include_usage. Must not
    // dereference response.usage!.  LIVE-VERIFY Together actually honors it —
    // otherwise cost silently → 0 and the credit engine under-bills.
    async function* noUsageStream() {
      yield { choices: [{ index: 0, delta: { role: 'assistant', content: 'done' } }] };
    }
    openaiCreate.mockImplementation(async () => noUsageStream());
    const ex = new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(res.message.content).toBe('done');
    expect(res.usage!.input_tokens).toBe(0);
    expect(res.usage!.output_tokens).toBe(0);
    expect(res.usage!.cache_read_input_tokens).toBe(0);
  });
});

describe('OpenAICompatibleExecutor — config-driven baseURL + credentials', () => {
  it('resolves baseURL from the provider registry and apiKey from creds keyed by provider name', () => {
    new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'together-key' } }),
    );
    expect(openaiCtor).toHaveBeenCalledTimes(1);
    const opts = openaiCtor.mock.calls[0][0];
    expect(opts.baseURL).toBe(OPENAI_COMPATIBLE_BASE_URLS.together);
    expect(opts.baseURL).toBe('https://api.together.ai/v1');
    expect(opts.apiKey).toBe('together-key');
  });

  it('lets a NEW provider work with config only — baseURL from model metadata, no registry entry', () => {
    new OpenAICompatibleExecutor(
      makeConfig('someNewHost', 'some/model', { someNewHost: { apiKey: 'x' } }, { baseURL: 'https://api.newhost.ai/v1' }),
    );
    const opts = openaiCtor.mock.calls[0][0];
    expect(opts.baseURL).toBe('https://api.newhost.ai/v1');
    expect(opts.apiKey).toBe('x');
  });

  it('creds.baseURL overrides the registry default', () => {
    new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k', baseURL: 'https://proxy.internal/v1' } }),
    );
    expect(openaiCtor.mock.calls[0][0].baseURL).toBe('https://proxy.internal/v1');
  });

  it('throws when the provider creds exist but have no apiKey', () => {
    expect(
      () => new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { together: {} as any })),
    ).toThrow(/credentials\.together\.apiKey is required/);
  });

  it('throws a clear error when credentials for the provider are missing', () => {
    expect(
      () => new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { openai: { apiKey: 'k' } })),
    ).toThrow(/credentials\.together is required/);
  });

  it('does not leak model-metadata adapter keys (baseURL/cacheMode/quantization) into request params', async () => {
    mockStream({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    });
    const ex = new OpenAICompatibleExecutor(
      makeConfig('together', 'moonshotai/Kimi-K2', { together: { apiKey: 'k' } },
        { baseURL: 'https://api.together.ai/v1', cacheMode: 'automatic', quantization: 'FP4', temperature: 0.4 }),
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);
    const sent = openaiCreate.mock.calls[0][0];
    expect(sent.temperature).toBe(0.4);      // real model param passes through
    expect(sent.baseURL).toBeUndefined();     // adapter config does not
    expect(sent.cacheMode).toBeUndefined();
    expect(sent.quantization).toBeUndefined();
  });
});

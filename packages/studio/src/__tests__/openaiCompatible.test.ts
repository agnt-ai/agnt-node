/**
 * OpenAICompatibleExecutor tests.
 *
 * This shared adapter serves every OpenAI-compatible host (Together, Fireworks,
 * DeepInfra, DeepSeek, …). Two things it MUST get right for the Kimi/Qwen
 * cost/quality experiment:
 *
 *  1. Capture automatic cache-read tokens from prompt_tokens_details.cached_tokens.
 *     The old standalone DeepSeek adapter dropped these — which on our
 *     ~99%-cached workload would silently make cache hit rate read as 0% and
 *     overstate cost ~5x. This is the highest-risk defect class in the project,
 *     so it is pinned here the same way providerUsage.test.ts pins OpenAI.
 *  2. Resolve baseURL + credentials from CONFIG (provider registry / creds /
 *     model metadata), so adding a new provider is config-only, no new code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the OpenAI client constructor args so we can assert baseURL/apiKey.
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

beforeEach(() => vi.clearAllMocks());

describe('OpenAICompatibleExecutor — cache-read capture (Together / Kimi)', () => {
  it('captures cached_tokens and subtracts them from prompt_tokens (disjoint buckets)', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: undefined } }],
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
    openaiCreate.mockResolvedValue({
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
    openaiCreate.mockResolvedValue({
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

  it('reports 0 cache reads when the provider returns no cached_tokens (cold prefix)', async () => {
    openaiCreate.mockResolvedValue({
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
    openaiCreate.mockResolvedValue({
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

  it('throws a clear error when credentials for the provider are missing', () => {
    expect(
      () => new OpenAICompatibleExecutor(makeConfig('together', 'moonshotai/Kimi-K2', { openai: { apiKey: 'k' } })),
    ).toThrow(/credentials\.together is required/);
  });

  it('does not leak model-metadata adapter keys (baseURL/cacheMode/quantization) into request params', async () => {
    openaiCreate.mockResolvedValue({
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

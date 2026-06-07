/**
 * Provider usage-normalization tests.
 *
 * The whole cost/usage pipeline assumes the four token buckets are DISJOINT:
 *   input_tokens (UNCACHED) + cache_read_input_tokens + cache_creation_input_tokens
 * recovers the inclusive prompt total by summation, and cost is the sum of the
 * disjoint buckets priced at their own rates.
 *
 * Anthropic already reports a disjoint input_tokens (cache excluded).
 * OpenAI's prompt_tokens and Google's promptTokenCount INCLUDE the cached
 * tokens, so the provider adapters must subtract the cached count back out.
 * These tests pin that behaviour and prove cache reads aren't double-counted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// SDK mocks — capture the raw provider usage shapes and return canned responses
// ─────────────────────────────────────────────────────────────────────────────

const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

const googleGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: googleGenerateContent }),
  })),
}));

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));

import OpenAIExecutor from '../providers/openai.js';
import GoogleExecutor from '../providers/google.js';
import AnthropicExecutor from '../providers/anthropic.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(provider: string, model: string): PromptManifestV2 {
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
      models: [{ provider, model }],
      dependencies: [],
    },
  };
}

function makeConfig(provider: string, model: string, creds: any): BaseExecutorConfig {
  return {
    manifest: makeManifest(provider, model),
    credentials: creds,
    logLevel: 'silent',
  } as BaseExecutorConfig;
}

// Inclusive prompt total = uncached input + cache_read + cache_creation.
// This is what sumInputTokens() reconstructs and what LangSmith wants.
function inclusiveInputTotal(u: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}) {
  return (
    (u.input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI: prompt_tokens INCLUDES cached_tokens → must be subtracted out
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAIExecutor usage normalization', () => {
  it('subtracts cached_tokens from prompt_tokens so input_tokens is UNCACHED', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: undefined } }],
      usage: {
        prompt_tokens: 1000, // INCLUDES the 300 cached
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 300 },
      },
    });

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(700); // 1000 - 300 (uncached only)
    expect(usage.cache_read_input_tokens).toBe(300);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(50);
  });

  it('keeps buckets disjoint: inclusive total still equals raw prompt_tokens', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 300 },
      },
    });

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    // Summation recovers the provider's inclusive prompt total — no over-count.
    expect(inclusiveInputTotal(usage)).toBe(1000);
    // Disjoint: cache_read is NOT also inside input_tokens.
    expect(usage.input_tokens! + usage.cache_read_input_tokens!).toBe(1000);
  });

  it('no cache reads: input_tokens equals prompt_tokens', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 800, completion_tokens: 20 },
    });

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(800);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
  });

  it('cost is not double-charged for cache reads (disjoint pricing)', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 1_000_000, // includes 1M cached
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 1_000_000 },
      },
    });

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    // Emulate the pipeline's disjoint-bucket cost: input*inRate + read*readRate.
    const inRate = 2.5;
    const readRate = 1.25;
    const cost =
      (usage.input_tokens! / 1_000_000) * inRate +
      (usage.cache_read_input_tokens! / 1_000_000) * readRate;

    // All 1M tokens were cached → input_tokens is 0, so only the read rate applies.
    expect(cost).toBeCloseTo(1.25, 6);
    // The buggy (pre-fix) behaviour would charge input on the full 1M too:
    // 2.5 + 1.25 = 3.75. Assert we are NOT doing that.
    expect(cost).not.toBeCloseTo(3.75, 6);
  });

  it('clamps to 0 if cached_tokens somehow exceeds prompt_tokens', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 250 },
      },
    });

    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(250);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Google: promptTokenCount INCLUDES cachedContentTokenCount → subtract it out
// ─────────────────────────────────────────────────────────────────────────────

describe('GoogleExecutor usage normalization', () => {
  function mockResponse(usageMetadata: any) {
    return {
      response: {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata,
      },
    };
  }

  it('subtracts cachedContentTokenCount so input_tokens is UNCACHED', async () => {
    googleGenerateContent.mockResolvedValue(
      mockResponse({
        promptTokenCount: 2000, // INCLUDES the 800 cached
        candidatesTokenCount: 100,
        cachedContentTokenCount: 800,
      })
    );

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(1200); // 2000 - 800
    expect(usage.cache_read_input_tokens).toBe(800);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(100);
  });

  it('keeps buckets disjoint: inclusive total equals raw promptTokenCount', async () => {
    googleGenerateContent.mockResolvedValue(
      mockResponse({
        promptTokenCount: 2000,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 800,
      })
    );

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(inclusiveInputTotal(usage)).toBe(2000);
    expect(usage.input_tokens! + usage.cache_read_input_tokens!).toBe(2000);
  });

  it('still folds thoughtsTokenCount into output tokens', async () => {
    googleGenerateContent.mockResolvedValue(
      mockResponse({
        promptTokenCount: 500,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 60,
        cachedContentTokenCount: 100,
      })
    );

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.5-pro', { google: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(400); // 500 - 100
    expect(usage.cache_read_input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(100); // 40 + 60
  });

  it('no cache: input_tokens equals promptTokenCount', async () => {
    googleGenerateContent.mockResolvedValue(
      mockResponse({ promptTokenCount: 500, candidatesTokenCount: 40 })
    );

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(usage.input_tokens).toBe(500);
    expect(usage.cache_read_input_tokens).toBe(0);
  });

  it('cost is not double-charged for cache reads (disjoint pricing)', async () => {
    googleGenerateContent.mockResolvedValue(
      mockResponse({
        promptTokenCount: 1_000_000,
        candidatesTokenCount: 0,
        cachedContentTokenCount: 1_000_000,
      })
    );

    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    const inRate = 1;
    const readRate = 0.25;
    const cost =
      (usage.input_tokens! / 1_000_000) * inRate +
      (usage.cache_read_input_tokens! / 1_000_000) * readRate;

    expect(cost).toBeCloseTo(0.25, 6); // only the cache-read rate
    expect(cost).not.toBeCloseTo(1.25, 6); // not input + read on the same tokens
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic: already disjoint — must pass usage through unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicExecutor usage normalization (already disjoint)', () => {
  it('passes through input_tokens unchanged (cache already excluded)', async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 700, // Anthropic: UNCACHED only, disjoint from cache buckets
        output_tokens: 50,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 120,
      },
    });

    const ex = new AnthropicExecutor(
      makeConfig('anthropic', 'claude-sonnet-4-5', { anthropic: { apiKey: 'k' } })
    );
    const { usage } = await ex.invoke([{ role: 'user', content: 'hi' }]);

    // No subtraction applied — value is reported verbatim.
    expect(usage.input_tokens).toBe(700);
    expect(usage.cache_read_input_tokens).toBe(300);
    expect(usage.cache_creation_input_tokens).toBe(120);
    expect(usage.output_tokens).toBe(50);
    // Inclusive total = 700 + 300 + 120 = 1120; buckets are disjoint.
    expect(inclusiveInputTotal(usage)).toBe(1120);
  });
});

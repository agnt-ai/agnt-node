/**
 * OpenAIExecutor reasoning-family param translation.
 *
 * Root-caused in agnt-backend log-sweep 2026-07-16 (findings #33/#34/#37):
 * OpenAIExecutor had zero per-model param translation — it passed an account's
 * model-strategy `metadata` object straight through as literal OpenAI request
 * params. A model-strategy for `openai/gpt-5.4` carried `max_tokens`
 * (mirroring the convention used for Anthropic models), and the cross-provider
 * fallback path (Anthropic overload → OpenAI safety net) immediately 400'd:
 *   "Unsupported parameter: 'max_tokens' is not supported with this model.
 *    Use 'max_completion_tokens' instead."
 *
 * These tests pin the fix: for reasoning-family models (o1/o3/o4, gpt-5.x),
 * `max_tokens` is translated to `max_completion_tokens`, and legacy sampling
 * params (temperature/top_p/etc.) are stripped rather than sent through and
 * rejected. Non-reasoning models (gpt-4o, gpt-4.1, ...) are unaffected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAIStreamFromCompletion } from './_streamMocks.js';

const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
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

function stubCompletion() {
  openaiCreate.mockImplementation(async () =>
    openAIStreamFromCompletion({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenAIExecutor reasoning-family param translation', () => {
  it('translates max_tokens -> max_completion_tokens for gpt-5.x', async () => {
    stubCompletion();
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-5.4', { max_tokens: 4096 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sentParams = openaiCreate.mock.calls[0][0];
    expect(sentParams.max_completion_tokens).toBe(4096);
    expect(sentParams.max_tokens).toBeUndefined();
  });

  it('translates max_tokens -> max_completion_tokens for o1/o3/o4', async () => {
    for (const model of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini']) {
      stubCompletion();
      const ex = new OpenAIExecutor(makeConfig('openai', model, { max_tokens: 2048 }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);

      const sentParams = openaiCreate.mock.calls[0][0];
      expect(sentParams.max_completion_tokens).toBe(2048);
      expect(sentParams.max_tokens).toBeUndefined();
      vi.clearAllMocks();
    }
  });

  it('strips temperature/top_p (and other legacy sampling params) for reasoning-family models', async () => {
    stubCompletion();
    const ex = new OpenAIExecutor(
      makeConfig('openai', 'gpt-5.4', {
        max_tokens: 4096,
        temperature: 0.7,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
      })
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sentParams = openaiCreate.mock.calls[0][0];
    expect(sentParams.temperature).toBeUndefined();
    expect(sentParams.top_p).toBeUndefined();
    expect(sentParams.frequency_penalty).toBeUndefined();
    expect(sentParams.presence_penalty).toBeUndefined();
  });

  it('leaves non-reasoning models (gpt-4o) untouched', async () => {
    stubCompletion();
    const ex = new OpenAIExecutor(
      makeConfig('openai', 'gpt-4o', { max_tokens: 4096, temperature: 0.7 })
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sentParams = openaiCreate.mock.calls[0][0];
    expect(sentParams.max_tokens).toBe(4096);
    expect(sentParams.max_completion_tokens).toBeUndefined();
    expect(sentParams.temperature).toBe(0.7);
  });

  it('does not misclassify gpt-4o as reasoning-family (no false-positive o-series match)', async () => {
    stubCompletion();
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o-mini', { max_tokens: 1024 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sentParams = openaiCreate.mock.calls[0][0];
    expect(sentParams.max_tokens).toBe(1024);
    expect(sentParams.max_completion_tokens).toBeUndefined();
  });

  it('passes reasoning_effort/verbosity through unchanged for reasoning-family models', async () => {
    stubCompletion();
    const ex = new OpenAIExecutor(
      makeConfig('openai', 'gpt-5.4', { max_tokens: 4096, reasoning_effort: 'high', verbosity: 'low' })
    );
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sentParams = openaiCreate.mock.calls[0][0];
    expect(sentParams.reasoning_effort).toBe('high');
    expect(sentParams.verbosity).toBe('low');
  });
});

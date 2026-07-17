/**
 * OpenAICompatibleExecutor reasoning-only param translation for Kimi K3
 * (Moonshot AI, direct — provider 'moonshot').
 *
 * Mirrors ../../__tests__/openaiReasoningParams.test.ts (OpenAIExecutor's
 * o-series/gpt-5.x handling), which exists because of a real prod 400 when a
 * reasoning model was sent the classic `max_tokens`/`temperature` params.
 * Moonshot's own docs state the identical constraint for Kimi K3: thinking
 * mode is always on, temperature/top_p/n/presence_penalty/frequency_penalty
 * are fixed and must be omitted, and output length is capped via
 * `max_completion_tokens`, not `max_tokens`. These tests pin that translation
 * before it ever reaches a live 400.
 */

import { describe, it, expect, vi } from 'vitest';
import OpenAICompatibleExecutor from '../openaiCompatible.js';

function makeManifest(model: string, extra: Record<string, any> = {}) {
  return {
    kind: 'PromptManifest',
    apiVersion: 'v2',
    spec: {
      models: [{ provider: 'moonshot', model, ...extra }],
      files: [],
      tools: [],
    },
  } as any;
}

function makeExecutor(model: string, extra: Record<string, any> = {}) {
  const ex = new OpenAICompatibleExecutor({
    manifest: makeManifest(model, extra),
    credentials: { moonshot: { apiKey: 'sk-test' } },
    logLevel: 'silent',
  } as any);

  const create = vi.fn(async function* () {
    yield { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] };
    yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  });
  (ex as any).client = { chat: { completions: { create } } };
  return { ex, create };
}

describe('OpenAICompatibleExecutor — Kimi K3 reasoning-only param translation', () => {
  it('translates max_tokens -> max_completion_tokens for kimi-k3', async () => {
    const { ex, create } = makeExecutor('kimi-k3', { maxTokens: 4096 });
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    const sentParams = create.mock.calls[0][0];
    expect(sentParams.max_completion_tokens).toBe(4096);
    expect(sentParams.max_tokens).toBeUndefined();
  });

  it('strips temperature/top_p (and other legacy sampling params) for kimi-k3', async () => {
    const { ex, create } = makeExecutor('kimi-k3', {
      maxTokens: 4096,
      temperature: 0.7,
      metadata: { top_p: 0.9, frequency_penalty: 0.1, presence_penalty: 0.1 },
    });
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    const sentParams = create.mock.calls[0][0];
    expect(sentParams.temperature).toBeUndefined();
    expect(sentParams.top_p).toBeUndefined();
    expect(sentParams.frequency_penalty).toBeUndefined();
    expect(sentParams.presence_penalty).toBeUndefined();
  });

  it('leaves other moonshot models untouched (no false-positive match)', async () => {
    const { ex, create } = makeExecutor('kimi-k2-0711-preview', { maxTokens: 4096, temperature: 0.7 });
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    const sentParams = create.mock.calls[0][0];
    expect(sentParams.max_tokens).toBe(4096);
    expect(sentParams.max_completion_tokens).toBeUndefined();
    expect(sentParams.temperature).toBe(0.7);
  });

  it('passes reasoning_effort through unchanged for kimi-k3', async () => {
    const { ex, create } = makeExecutor('kimi-k3', {
      maxTokens: 4096,
      metadata: { reasoning_effort: 'max' },
    });
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    const sentParams = create.mock.calls[0][0];
    expect(sentParams.reasoning_effort).toBe('max');
  });
});

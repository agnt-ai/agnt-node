/**
 * AnthropicExecutor reasoning support (opt-in via reasoning_effort).
 *
 * On the current Claude reasoning family (Opus 4.7/4.8, Sonnet 5, Fable 5),
 * reasoning is driven by adaptive thinking + `output_config.effort`; the legacy
 * sampling knobs and `budget_tokens` 400 alongside it, and thinking is OFF
 * unless `thinking:{type:'adaptive'}` is sent. The adapter maps the console's
 * `metadata.reasoning_effort` onto that surface — but ONLY when it's set, so
 * existing (non-reasoning) traffic is unchanged. Thinking blocks are round-
 * tripped verbatim so multi-turn tool use doesn't 400.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { anthropicMessageStream } from './_streamMocks.js';

const anthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () { return {
    messages: { stream: anthropicStream },
  }; }),
}));

import AnthropicExecutor from '../providers/anthropic.js';
import { HookRegistry } from '../hooks.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function makeManifest(model: string, metadata: Record<string, any>): PromptManifestV2 {
  return {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest', apiVersion: 'v2',
    metadata: { name: 't', title: 'T', description: '' },
    spec: {
      routingStrategy: 'fallback', enableToolCalls: true, variables: [], files: [], tools: [],
      models: [{ provider: 'anthropic', model, metadata }], dependencies: [],
    },
  };
}

function config(model: string, metadata: Record<string, any>): BaseExecutorConfig {
  return {
    manifest: makeManifest(model, metadata),
    credentials: { anthropic: { apiKey: 'k' } },
    logLevel: 'silent',
  } as BaseExecutorConfig;
}

function stub(
  content: any[] = [{ type: 'text', text: 'hi' }],
  usage: Record<string, any> = { input_tokens: 10, output_tokens: 5 },
) {
  anthropicStream.mockReturnValue(
    anthropicMessageStream({ content, usage })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnthropicExecutor reasoning (opt-in)', () => {
  it('carries reported thinking tokens to normalized usage and the llm_output hook without changing inclusive totals', async () => {
    const hooks = new HookRegistry();
    let tracePayload: Record<string, any> | undefined;
    hooks.register('llm_output', async (payload) => {
      tracePayload = payload;
    });
    stub(undefined, {
      input_tokens: 40,
      output_tokens: 120,
      output_tokens_details: { thinking_tokens: 80 },
    });
    const ex = new AnthropicExecutor({ ...config('claude-opus-4-8', { reasoning_effort: 'high' }), hooks });

    const result = await ex.execute();

    expect(result.usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 120,
      reasoningTokens: 80,
    });
    expect(tracePayload).toMatchObject({
      inputTokens: 40,
      outputTokens: 120,
      totalTokens: 160,
      reasoningTokens: 80,
    });
  });

  it('leaves missing thinking usage unknown and preserves an explicit zero', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { reasoning_effort: 'high' }));
    const missing = await ex.invoke([{ role: 'user', content: 'hi' }]);
    expect(missing.usage).not.toHaveProperty('reasoning_output_tokens');

    vi.clearAllMocks();
    stub(undefined, {
      input_tokens: 12,
      output_tokens: 5,
      output_tokens_details: { thinking_tokens: 0 },
    });
    const zero = await ex.invoke([{ role: 'user', content: 'hi' }]);
    expect(zero.usage?.reasoning_output_tokens).toBe(0);
  });

  it('maps reasoning_effort -> output_config.effort + adaptive thinking for the reasoning family', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { reasoning_effort: 'high', temperature: 0.7, top_p: 0.9 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.output_config).toEqual({ effort: 'high' });
    // Sampling knobs are stripped (they 400 alongside adaptive thinking), and the
    // cross-provider key never leaks through as a top-level Anthropic param.
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
  });

  it('applies to Sonnet 5 / Opus 4.7 / Fable 5 as well', async () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-4-7', 'claude-fable-5']) {
      stub();
      const ex = new AnthropicExecutor(config(model, { reasoning_effort: 'xhigh' }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);
      const sent = anthropicStream.mock.calls[0][0];
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect(sent.output_config).toEqual({ effort: 'xhigh' });
      vi.clearAllMocks();
    }
  });

  it('maps reasoning_effort -> legacy budget_tokens thinking on Haiku 4.5 (no adaptive/effort there)', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-haiku-4-5', { reasoning_effort: 'high', maxTokens: 16000 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    // No adaptive-thinking surface on this model — output_config.effort is a 400 there.
    expect(sent.output_config).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
    // budget_tokens must be strictly less than max_tokens.
    expect(sent.thinking.budget_tokens).toBeLessThan(sent.max_tokens);
  });

  it('also maps legacy thinking for Sonnet 4.5 / Opus 4.6 / Opus 4.5', async () => {
    for (const model of ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-opus-4-5']) {
      stub();
      const ex = new AnthropicExecutor(config(model, { reasoning_effort: 'medium', maxTokens: 16000 }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);
      const sent = anthropicStream.mock.calls[0][0];
      expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
      expect(sent.output_config).toBeUndefined();
      vi.clearAllMocks();
    }
  });

  it('strips incompatible sampling parameters for manual thinking', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-haiku-4-5', { reasoning_effort: 'low', maxTokens: 16000, temperature: 0.7, top_p: 0.9 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
  });

  it('clamps the legacy thinking budget to leave room for max_tokens (never >= max_tokens)', async () => {
    stub();
    // 'max' tier targets 32768, but max_tokens here only leaves 1536 of headroom.
    const ex = new AnthropicExecutor(config('claude-haiku-4-5', { reasoning_effort: 'max', maxTokens: 2560 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking.type).toBe('enabled');
    expect(sent.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(sent.thinking.budget_tokens).toBeLessThan(sent.max_tokens);
  });

  it('skips legacy thinking entirely when max_tokens leaves no room for even the minimum budget', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-haiku-4-5', { reasoning_effort: 'high', maxTokens: 1500 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toBeUndefined();
  });

  it('drops reasoning_effort (no thinking) on a model outside both families', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-instant-1', { reasoning_effort: 'high', maxTokens: 16000 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toBeUndefined();
    expect(sent.output_config).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
  });

  it('keeps default thinking but strips rejected sampling knobs when effort is unset', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { temperature: 0.5 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toBeUndefined();
    expect(sent.output_config).toBeUndefined();
    // Current model families reject sampling knobs independently of effort.
    expect(sent.temperature).toBeUndefined();
  });

  it('captures response thinking blocks into rawParts', async () => {
    stub([
      { type: 'thinking', thinking: 'let me think', signature: 'sig123' },
      { type: 'text', text: 'answer' },
    ]);
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { reasoning_effort: 'high' }));
    const res = await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(res.message.content).toBe('answer');
    expect(res.message.rawParts).toEqual([
      { type: 'thinking', thinking: 'let me think', signature: 'sig123' },
    ]);
  });

  it('round-trips thinking blocks verbatim ahead of tool_use on replay', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { reasoning_effort: 'high' }));
    const thinkingBlock = { type: 'thinking', thinking: 'plan', signature: 'sig' };
    await ex.invoke([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        rawParts: [thinkingBlock],
        tool_calls: [{ id: 'toolu_1', name: 'search', args: { q: 'x' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
    ]);

    const sent = anthropicStream.mock.calls[0][0];
    const assistant = sent.messages.find((m: any) => m.role === 'assistant');
    // Thinking block is first, unchanged (signature intact), then the tool_use.
    expect(assistant.content[0]).toEqual(thinkingBlock);
    expect(assistant.content.some((b: any) => b.type === 'tool_use' && b.id === 'toolu_1')).toBe(true);
    const thinkIdx = assistant.content.findIndex((b: any) => b.type === 'thinking');
    const toolIdx = assistant.content.findIndex((b: any) => b.type === 'tool_use');
    expect(thinkIdx).toBeLessThan(toolIdx);
  });
});

describe('AnthropicExecutor Opus 5.5 / Sonnet 5.5', () => {
  it('maps effort + adaptive thinking and strips sampling knobs', async () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5']) {
      stub();
      const ex = new AnthropicExecutor(config(model, { reasoning_effort: 'high', temperature: 1, top_p: 0.9, top_k: 40 }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);
      const sent = anthropicStream.mock.calls[0][0];
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect(sent.output_config).toEqual({ effort: 'high' });
      expect(sent.temperature).toBeUndefined();
      expect(sent.top_p).toBeUndefined();
      expect(sent.top_k).toBeUndefined();
      vi.clearAllMocks();
    }
  });

  it('strips sampling knobs even when no effort is set (they 400 on the family regardless)', async () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      stub();
      const ex = new AnthropicExecutor(config(model, { temperature: 1 }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);
      const sent = anthropicStream.mock.calls[0][0];
      expect(sent.temperature).toBeUndefined();
      expect(sent.thinking).toBeUndefined();
      vi.clearAllMocks();
    }
  });

  it('strips rejected Sonnet 5 / Fable 5 / Opus 5 sampling params when effort is unset', async () => {
    for (const model of ['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5']) {
      stub();
      const ex = new AnthropicExecutor(config(model, { temperature: 0.4 }));
      await ex.invoke([{ role: 'user', content: 'hi' }]);
      expect(anthropicStream.mock.calls[0][0].temperature).toBeUndefined();
      vi.clearAllMocks();
    }
  });

  it('still lets Haiku 4.5 keep temperature', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-haiku-4-5-20251001', { temperature: 0.3 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);
    expect(anthropicStream.mock.calls[0][0].temperature).toBe(0.3);
  });
});

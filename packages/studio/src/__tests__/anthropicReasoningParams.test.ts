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
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: anthropicStream },
  })),
}));

import AnthropicExecutor from '../providers/anthropic.js';
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

function stub(content: any[] = [{ type: 'text', text: 'hi' }]) {
  anthropicStream.mockReturnValue(
    anthropicMessageStream({ content, usage: { input_tokens: 10, output_tokens: 5 } })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnthropicExecutor reasoning (opt-in)', () => {
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

  it('drops reasoning_effort (no thinking) on a non-reasoning model like Haiku 4.5', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-haiku-4-5', { reasoning_effort: 'high' }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toBeUndefined();
    expect(sent.output_config).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
  });

  it('is a no-op when reasoning_effort is unset (existing behavior unchanged)', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { temperature: 0.5 }));
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toBeUndefined();
    expect(sent.output_config).toBeUndefined();
    // Without opt-in we don't touch sampling params — behavior is unchanged.
    expect(sent.temperature).toBe(0.5);
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

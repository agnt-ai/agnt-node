/**
 * Regression: Anthropic rejects `tool_choice: {type:'tool', name:...}`
 * ("specified") when `thinking` is active (400). Confirmed from a production
 * trace where `forceNextTool` sent exactly that shape on the next turn after
 * a reasoning-family model call. Fix: downgrade to `{type:'any'}` when
 * thinking is on — still forces a tool call, just not a specific one, which
 * is what the API allows alongside thinking.
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

describe('AnthropicExecutor tool_choice downgrade when thinking is active', () => {
  it('downgrades a specified tool_choice to {type:"any"} when thinking is on (the production 400)', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { reasoning_effort: 'high' }));
    await ex.invoke(
      [{ role: 'user', content: 'hi' }],
      { tool_choice: { type: 'function', function: { name: 'set_alarm' } } },
    );

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    // Must NOT be the specific-tool shape Anthropic rejects alongside thinking.
    expect(sent.tool_choice).toEqual({ type: 'any' });
    expect(sent.tool_choice.name).toBeUndefined();
  });

  it('keeps the specified tool_choice untouched when thinking is off', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', {}));
    await ex.invoke(
      [{ role: 'user', content: 'hi' }],
      { tool_choice: { type: 'function', function: { name: 'set_alarm' } } },
    );

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toBeUndefined();
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'set_alarm' });
  });

  it('leaves an already-generic tool_choice (any/required) alone when thinking is on', async () => {
    stub();
    const ex = new AnthropicExecutor(config('claude-opus-4-8', { reasoning_effort: 'high' }));
    await ex.invoke(
      [{ role: 'user', content: 'hi' }],
      { tool_choice: 'required' },
    );

    const sent = anthropicStream.mock.calls[0][0];
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.tool_choice).toEqual({ type: 'any' });
  });
});

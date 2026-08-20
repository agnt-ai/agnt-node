/**
 * AnthropicExecutor — defensive detection of a leaked tool call.
 *
 * Some models occasionally write a tool call into visible text, or into a
 * string-valued argument of an otherwise-real tool call, as legacy pseudo-XML
 * (`<function_calls><invoke name="...">`) instead of a proper `tool_use`
 * block. The call never executes and nothing else surfaces this — it
 * silently wastes a turn. Confirmed live 2026-08-20: a workflow-mode
 * claude-haiku-4-5 run leaked a `finish_agent_run` call this way twice in one
 * run, stuffed inside a `think` call's `thought` argument and then inside a
 * real `finish_agent_run` call's own `summary` argument — NOT as bare
 * top-level text with no tool_use at all, which is why the detector has to
 * scan tool-call argument strings too, not just extracted text.
 *
 * This only logs — it never parses/recovers the leaked call.
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

function makeManifest(model: string, metadata: Record<string, any> = {}): PromptManifestV2 {
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

function config(model = 'claude-haiku-4-5', metadata: Record<string, any> = {}): BaseExecutorConfig {
  return {
    manifest: makeManifest(model, metadata),
    credentials: { anthropic: { apiKey: 'k' } },
    logLevel: 'silent',
  } as BaseExecutorConfig;
}

function stub(content: any[]) {
  anthropicStream.mockReturnValue(
    anthropicMessageStream({ content, usage: { input_tokens: 10, output_tokens: 5 } })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnthropicExecutor — leaked tool call detection', () => {
  it('warns when a leaked call appears in bare top-level text (no tool_use at all)', async () => {
    stub([
      { type: 'text', text: 'Some reasoning...\n<function_calls>\n<invoke name="finish_agent_run">\n<parameter name="summary">done</parameter>\n</invoke>\n</function_calls>' },
    ]);
    const ex = new AnthropicExecutor(config());
    const logSpy = vi.spyOn(ex as any, 'log');
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Detected leaked tool call in model output'));
  });

  it('warns when a leaked call is stuffed inside a real tool call\'s string argument (the observed live shape)', async () => {
    stub([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'think',
        input: { thought: 'Reasoning...\n<function_calls>\n<invoke name="finish_agent_run">\n<parameter name="summary">done</parameter>' },
      },
    ]);
    const ex = new AnthropicExecutor(config());
    const logSpy = vi.spyOn(ex as any, 'log');
    const res = await ex.invoke([{ role: 'user', content: 'hi' }]);

    // The real tool_use (think) still comes through untouched — this is
    // observability only, not recovery/mutation of the response.
    expect(res.message.tool_calls).toEqual([
      { id: 'toolu_1', name: 'think', args: expect.objectContaining({ thought: expect.any(String) }) },
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Detected leaked tool call in model output'));
  });

  it('does not fire on a normal text-only response', async () => {
    stub([{ type: 'text', text: 'Here is a summary of what I found.' }]);
    const ex = new AnthropicExecutor(config());
    const logSpy = vi.spyOn(ex as any, 'log');
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Detected leaked tool call in model output'));
  });

  it('does not false-positive on a normal tool call whose args merely mention "invoke" or contain angle brackets', async () => {
    stub([
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'user_email_search',
        input: { query: 'subject:"please invoke the <billing> team"' },
      },
    ]);
    const ex = new AnthropicExecutor(config());
    const logSpy = vi.spyOn(ex as any, 'log');
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Detected leaked tool call in model output'));
  });

  it('does not false-positive on a normal real tool_use with no leaked text anywhere', async () => {
    stub([
      { type: 'text', text: 'Let me check that for you.' },
      { type: 'tool_use', id: 'toolu_3', name: 'search', args: { q: 'x' } },
    ]);
    const ex = new AnthropicExecutor(config());
    const logSpy = vi.spyOn(ex as any, 'log');
    await ex.invoke([{ role: 'user', content: 'hi' }]);

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Detected leaked tool call in model output'));
  });
});

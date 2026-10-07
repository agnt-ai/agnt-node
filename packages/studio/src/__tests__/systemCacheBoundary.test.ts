/**
 * System messages with a cache boundary (providers/systemContent.ts).
 *
 * A caller sends a stable system prefix and a per-call part as text parts, marking the stable one `cacheBoundary`.
 * Anthropic must get one block per part with the breakpoint on the stable one, so the prefix is read across calls
 * while the per-call part changes. Every automatic-prefix-caching provider must get exactly the joined string,
 * stable prefix first. A plain string system message must be unchanged everywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { anthropicMessageStream, openAIStreamFromCompletion } from './_streamMocks.js';

const anthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { stream: anthropicStream } }; }),
}));
const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return { chat: { completions: { create: openaiCreate } } }; }),
}));

import AnthropicExecutor from '../providers/anthropic.js';
import OpenAICompatibleExecutor from '../providers/openaiCompatible.js';
import { anthropicSystem, systemText, withFlatSystemMessages, SYSTEM_CACHE_BOUNDARY_SUPPORT } from '../providers/systemContent.js';
import * as pkg from '../index.js';
import type { BaseExecutorConfig, PromptManifestV2, Message } from '../types.js';

function config(provider: string, model: string, credentials: any): BaseExecutorConfig {
  const manifest: PromptManifestV2 = {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json', kind: 'PromptManifest', apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: { routingStrategy: 'fallback', enableToolCalls: true, variables: [], files: [], tools: [], models: [{ provider, model }], dependencies: [] },
  };
  return { manifest, credentials, logLevel: 'silent' } as BaseExecutorConfig;
}

const STABLE = '## Identity\nYou are Ava.';
const split = (perCall: string): Message => ({
  role: 'system',
  content: [{ type: 'text', text: STABLE, cacheBoundary: true }, { type: 'text', text: perCall }],
});
const EPH = { type: 'ephemeral' };

beforeEach(() => {
  vi.clearAllMocks();
  anthropicStream.mockReturnValue(anthropicMessageStream({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  openaiCreate.mockImplementation(async () => openAIStreamFromCompletion({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});

describe('Anthropic: the stable part is its own cached block', () => {
  it('one block per part, the breakpoint on the cacheBoundary part, the later part uncached', async () => {
    const ex = new AnthropicExecutor(config('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    await ex.invoke([split('## Now\n9:00 AM'), { role: 'user', content: 'hi' }], {});
    const { system } = anthropicStream.mock.calls[0][0];
    expect(system).toEqual([
      { type: 'text', text: STABLE, cache_control: EPH },
      { type: 'text', text: '\n\n## Now\n9:00 AM' },
    ]);
  });

  it('across two calls with a different per-call part, the cached block is byte-identical', async () => {
    const ex = new AnthropicExecutor(config('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    await ex.invoke([split('9:00 AM'), { role: 'user', content: 'hi' }], {});
    await ex.invoke([split('9:09 AM'), { role: 'user', content: 'hi' }], {});
    const [a, b] = anthropicStream.mock.calls.map((c) => c[0].system);
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).not.toEqual(b[1]);
    // The model reads the same text a single string would have carried.
    expect(a.map((x: any) => x.text).join('')).toBe(`${STABLE}\n\n9:00 AM`);
  });

  it('keeps the breakpoint count: tools, the stable system block, the message tail (none on the per-call block)', async () => {
    const ex = new AnthropicExecutor(config('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }];
    await ex.invoke([split('per call'), { role: 'user', content: 'hi' }], { tools });
    const params = anthropicStream.mock.calls[0][0];
    const count = JSON.stringify(params).split('"cache_control"').length - 1;
    expect(count).toBe(3);
  });

  it('a plain string system message is unchanged: one block, cached at its end', async () => {
    const ex = new AnthropicExecutor(config('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    await ex.invoke([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], {});
    expect(anthropicStream.mock.calls[0][0].system).toEqual([{ type: 'text', text: 'SYS', cache_control: EPH }]);
  });

  it('disableCache: the joined string, no blocks', async () => {
    const ex = new AnthropicExecutor(config('anthropic', 'claude-x', { anthropic: { apiKey: 'k' } }));
    await ex.invoke([split('per call'), { role: 'user', content: 'hi' }], { disableCache: true });
    expect(anthropicStream.mock.calls[0][0].system).toBe(`${STABLE}\n\nper call`);
  });

  it('parts with no cacheBoundary: the breakpoint stays on the last block', () => {
    const system = anthropicSystem([{ role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }], true) as any[];
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual(EPH);
  });
});

describe('automatic prefix caching providers: the joined string, stable prefix first', () => {
  it('OpenAI-compatible sends exactly the text one string would have', async () => {
    const ex = new OpenAICompatibleExecutor(config('together', 'm', { together: { apiKey: 'k' } }));
    await ex.invoke([split('per call'), { role: 'user', content: 'hi' }], {});
    const sent = openaiCreate.mock.calls[0][0].messages;
    expect(sent[0]).toEqual({ role: 'system', content: `${STABLE}\n\nper call` });
  });

  it('the helpers: systemText joins text parts, withFlatSystemMessages leaves strings and other roles alone', () => {
    expect(systemText('x')).toBe('x');
    expect(systemText([{ type: 'text', text: 'a', cacheBoundary: true }, { type: 'text', text: 'b' }])).toBe('a\n\nb');
    const plain: Message[] = [{ role: 'system', content: 's' }, { role: 'user', content: [{ type: 'text', text: 'u' }] }];
    expect(withFlatSystemMessages(plain)).toBe(plain);
    const flat = withFlatSystemMessages([split('p'), { role: 'user', content: 'u' }]);
    expect(flat[0].content).toBe(`${STABLE}\n\np`);
  });

  it('the package says it supports cache-boundary parts', () => {
    expect(SYSTEM_CACHE_BOUNDARY_SUPPORT).toBe(1);
    expect((pkg as any).SYSTEM_CACHE_BOUNDARY_SUPPORT).toBe(1);
  });
});

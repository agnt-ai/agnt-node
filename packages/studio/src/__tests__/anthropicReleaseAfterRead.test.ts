/**
 * Anthropic prompt caching — always-on block-level breakpoints.
 *
 * The adapter ALWAYS uses explicit block-level cache_control (system block +
 * last tool + message-tail), because a top-level cache_control is not honored
 * by Anthropic (the old default left cache_read=0). `release_after_read`-flagged
 * tool results stay in the UNCACHED suffix (the breakpoint sits before trailing
 * read-once messages) so we don't pay to write content about to leave.
 * disableCache (one-shot callers) places no cache_control at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));

import AnthropicExecutor from '../providers/anthropic.js';
import type { BaseExecutorConfig, PromptManifestV2, Message } from '../types.js';

function makeConfig(): BaseExecutorConfig {
  const manifest: PromptManifestV2 = {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest',
    apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: {
      routingStrategy: 'fallback', enableToolCalls: true, variables: [], files: [],
      tools: [], models: [{ provider: 'anthropic', model: 'claude-x' }], dependencies: [],
    },
  };
  return { manifest, credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent' } as BaseExecutorConfig;
}

const RESP = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } };
const TOOLS = [{ name: 'fetch_tools', description: 'd', parameters: { type: 'object', properties: {} } }];

function lastCacheControl(block: any) {
  if (typeof block?.content === 'string') return undefined;
  if (Array.isArray(block?.content)) return block.content[block.content.length - 1]?.cache_control;
  return undefined;
}

beforeEach(() => { vi.clearAllMocks(); anthropicCreate.mockResolvedValue(RESP); });

describe('Anthropic cache — default path (always block-level)', () => {
  it('caches system-block + tools + the message tail; no top-level flag', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], { tools: TOOLS });
    const params = anthropicCreate.mock.calls[0][0];
    expect(params.cache_control).toBeUndefined();                       // top-level flag gone
    expect(Array.isArray(params.system)).toBe(true);                    // system is a cached block
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools[params.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // the (only) message is the stable tail → gets the message breakpoint
    expect(lastCacheControl(params.messages[params.messages.length - 1])).toEqual({ type: 'ephemeral' });
  });

  it('disableCache sets no cache_control anywhere (string system, no blocks)', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], { tools: TOOLS, disableCache: true });
    const params = anthropicCreate.mock.calls[0][0];
    expect(params.cache_control).toBeUndefined();
    expect(typeof params.system).toBe('string');
    expect(params.tools[params.tools.length - 1].cache_control).toBeUndefined();
    expect(lastCacheControl(params.messages[params.messages.length - 1])).toBeUndefined();
  });
});

describe('Anthropic cache — release_after_read present', () => {
  const msgs: Message[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'do x' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'fetch_tools', args: {} }] },
    { role: 'tool', tool_call_id: 't1', content: 'BIG CATALOG', releaseAfterRead: true },
  ];

  it('drops the top-level flag and caches system as a block', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(msgs, { tools: TOOLS });
    const params = anthropicCreate.mock.calls[0][0];
    expect(params.cache_control).toBeUndefined();              // no top-level
    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('caches the tools block', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(msgs, { tools: TOOLS });
    const params = anthropicCreate.mock.calls[0][0];
    expect(params.tools[params.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('places the breakpoint BEFORE the read-once message, not on it', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    await ex.invoke(msgs, { tools: TOOLS });
    const params = anthropicCreate.mock.calls[0][0];
    // formatted (system filtered): [0]=user, [1]=assistant(tool_use), [2]=tool_result(read-once)
    expect(lastCacheControl(params.messages[1])).toEqual({ type: 'ephemeral' }); // breakpoint
    expect(lastCacheControl(params.messages[2])).toBeUndefined();                 // read-once excluded
  });

  it('still excludes the read-once message when it is the first non-system message', async () => {
    const ex = new AnthropicExecutor(makeConfig());
    // read-once is formatted index 0 → no message-prefix breakpoint to place,
    // but system + tools still cache and the read-once stays uncached (no
    // top-level flag, no breakpoint on/after it).
    await ex.invoke(
      [{ role: 'system', content: 'SYS' }, { role: 'tool', tool_call_id: 't0', content: 'x', releaseAfterRead: true }],
      { tools: TOOLS },
    );
    const params = anthropicCreate.mock.calls[0][0];
    expect(params.cache_control).toBeUndefined();                 // no top-level write of the tail
    expect(Array.isArray(params.system)).toBe(true);              // system still cached
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(lastCacheControl(params.messages[0])).toBeUndefined();  // read-once excluded
  });
});

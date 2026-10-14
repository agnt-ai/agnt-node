/**
 * The per-provider caching table (promptCacheCapabilities.ts) and the wire rules it drives on the automatic-cache
 * adapters: the lane key reaches a provider only in the form it takes, the breakpoint switch never reaches any wire,
 * and cached tokens are read whatever spelling a host uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAIStreamFromCompletion, googleStreamResult } from './_streamMocks.js';

const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return { chat: { completions: { create: openaiCreate } } }; }),
}));
const getGenerativeModel = vi.fn();
const googleGenerateContentStream = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () { return {
    getGenerativeModel: (cfg: any) => { getGenerativeModel(cfg); return { generateContentStream: googleGenerateContentStream }; },
  }; }),
}));

import { promptCacheCapability, takesPromptCacheKey, bedrockTakesCachePoints } from '../providers/promptCacheCapabilities.js';
import OpenAICompatibleExecutor from '../providers/openaiCompatible.js';
import OpenAIExecutor from '../providers/openai.js';
import AzureFoundryExecutor from '../providers/azureFoundry.js';
import GoogleExecutor from '../providers/google.js';
import * as pkg from '../index.js';

function config(provider: string, model: string, metadata: Record<string, any>, creds: Record<string, any>): any {
  return {
    manifest: { kind: 'PromptManifest', apiVersion: 'v2', spec: { models: [{ provider, model, metadata }], files: [], tools: [] } },
    credentials: creds, logLevel: 'silent',
  };
}
const completion = (usage: any) => ({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage });
const MSGS = [{ role: 'system' as const, content: 'SYS' }, { role: 'user' as const, content: 'hi' }];

beforeEach(() => {
  vi.clearAllMocks();
  openaiCreate.mockImplementation(async () => openAIStreamFromCompletion(completion({ prompt_tokens: 1000, completion_tokens: 5 })));
});

describe('capability table', () => {
  it('lane key: OpenAI every model, Azure GPT-5.6+, xAI (header), Mistral (body); nobody else', () => {
    expect(takesPromptCacheKey('openai', 'gpt-4.1')).toBe(true);
    expect(takesPromptCacheKey('openai', 'gpt-6.1-sol')).toBe(true);
    expect(takesPromptCacheKey('azureFoundry', 'gpt-6-luna')).toBe(true);
    expect(takesPromptCacheKey('azureFoundry', 'gpt-5.4')).toBe(false);
    expect(takesPromptCacheKey('azureFoundry', 'DeepSeek-V3.2')).toBe(false);
    expect(promptCacheCapability('xai', 'grok-5').affinityKey).toBe('header');
    expect(promptCacheCapability('mistral', 'mistral-large-latest').affinityKey).toBe('body');
    for (const p of ['anthropic', 'bedrock', 'google', 'gemini', 'together', 'fireworks', 'deepinfra', 'deepseek', 'moonshot', 'groq', 'unknown']) {
      expect(takesPromptCacheKey(p, 'any-model')).toBe(false);
    }
  });

  it('mechanism and write billing', () => {
    expect(promptCacheCapability('anthropic', 'claude-haiku-4-5-20251001')).toMatchObject({ mechanism: 'explicit', billsWrites: true });
    expect(promptCacheCapability('openai', 'gpt-6.1-sol')).toMatchObject({ mechanism: 'explicit', billsWrites: true });
    expect(promptCacheCapability('openai', 'gpt-5.4')).toMatchObject({ mechanism: 'automatic', billsWrites: false });
    expect(promptCacheCapability('google', 'gemini-3.8-flash')).toMatchObject({ mechanism: 'automatic', billsWrites: false });
    expect(promptCacheCapability('bedrock', 'anthropic.claude-haiku-4-5-20251001-v1:0')).toMatchObject({ mechanism: 'explicit', billsWrites: true });
    expect(promptCacheCapability('bedrock', 'amazon.nova-pro-v1:0')).toMatchObject({ mechanism: 'automatic' });
  });

  it('Bedrock checkpoints: Claude by any inference-profile prefix or ARN, never the old uncached ones', () => {
    expect(bedrockTakesCachePoints('anthropic.claude-sonnet-5')).toBe(true);
    expect(bedrockTakesCachePoints('global.anthropic.claude-opus-4-8')).toBe(true);
    expect(bedrockTakesCachePoints('arn:aws:bedrock:us-east-2:1:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
    expect(bedrockTakesCachePoints('anthropic.claude-3-opus-20240229-v1:0')).toBe(false);
    expect(bedrockTakesCachePoints('anthropic.claude-3-5-haiku-20241022-v1:0')).toBe(false);
    expect(bedrockTakesCachePoints('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(false); // Preview on Bedrock
    expect(bedrockTakesCachePoints('anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(true);
    expect(bedrockTakesCachePoints('amazon.nova-pro-v1:0')).toBe(false);
  });

  it('is exported by the package for the backend to feature-detect', () => {
    expect(pkg.PROMPT_CACHE_CAPABILITIES_SUPPORT).toBe(1);
    expect(typeof pkg.takesPromptCacheKey).toBe('function');
  });
});

describe('OpenAI-compatible hosts', () => {
  const run = async (provider: string, metadata: Record<string, any>) => {
    const ex = new OpenAICompatibleExecutor(config(provider, 'm', { baseURL: 'https://h.example/v1', ...metadata }, { [provider]: { apiKey: 'k' } }));
    return ex.invoke(MSGS, {});
  };

  it('xAI: the lane key goes as the x-grok-conv-id routing header, not in the body', async () => {
    await run('xai', { prompt_cache_key: 'agnt-lane', prompt_cache_breakpoints: false });
    const [body, opts] = openaiCreate.mock.calls[0];
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_breakpoints).toBeUndefined();
    expect(opts.headers).toEqual({ 'x-grok-conv-id': 'agnt-lane' });
  });

  it('Mistral: the lane key goes in the body', async () => {
    await run('mistral', { prompt_cache_key: 'agnt-lane' });
    const [body, opts] = openaiCreate.mock.calls[0];
    expect(body.prompt_cache_key).toBe('agnt-lane');
    expect(opts.headers).toBeUndefined();
  });

  it('Together and other hosts: neither key reaches the wire', async () => {
    await run('together', { prompt_cache_key: 'agnt-lane', prompt_cache_breakpoints: false, temperature: 0.2 });
    const [body, opts] = openaiCreate.mock.calls[0];
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_breakpoints).toBeUndefined();
    expect(body.temperature).toBe(0.2);
    expect(opts.headers).toBeUndefined();
  });

  it.each([
    ['nested', { prompt_tokens_details: { cached_tokens: 600 } }],
    ['top-level (Moonshot, Together)', { cached_tokens: 600 }],
    ['DeepSeek', { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }],
    ['a zeroed nested field beside the real count', { prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 600 }],
  ])('cached tokens read from the %s spelling', async (_label, extra) => {
    openaiCreate.mockImplementation(async () => openAIStreamFromCompletion(completion({ prompt_tokens: 1000, completion_tokens: 5, ...extra })));
    const res = await run('deepseek', {});
    expect(res.usage).toMatchObject({ input_tokens: 400, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 });
  });

  it('a real nested count wins over a stale top-level one', async () => {
    openaiCreate.mockImplementation(async () => openAIStreamFromCompletion(completion({ prompt_tokens: 1000, completion_tokens: 5, cached_tokens: 999, prompt_tokens_details: { cached_tokens: 600 } })));
    const res = await run('together', {});
    expect(res.usage).toMatchObject({ input_tokens: 400, cache_read_input_tokens: 600 });
  });
});

describe('OpenAI and Azure Chat Completions paths', () => {
  it('OpenAI (pre-reasoning model): the lane key stays, the breakpoint switch never reaches the wire', async () => {
    const ex = new OpenAIExecutor(config('openai', 'gpt-4.1', { prompt_cache_key: 'agnt-lane', prompt_cache_breakpoints: false }, { openai: { apiKey: 'k' } }));
    await ex.invoke(MSGS, {});
    const [body] = openaiCreate.mock.calls[0];
    expect(body.prompt_cache_key).toBe('agnt-lane');
    expect(body.prompt_cache_breakpoints).toBeUndefined();
  });

  it('Azure Foundry hosted (non-OpenAI) model: neither key reaches the wire', async () => {
    const ex = new AzureFoundryExecutor(config('azureFoundry', 'DeepSeek-V3.2', { prompt_cache_key: 'agnt-lane', prompt_cache_breakpoints: false }, { azureFoundry: { apiKey: 'k', endpoint: 'https://x.services.ai.azure.com/openai/v1' } }));
    await ex.invoke(MSGS, {});
    const [body] = openaiCreate.mock.calls[0];
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_breakpoints).toBeUndefined();
  });
});

describe('Google Gemini (implicit caching)', () => {
  it('caching metadata never reaches the model config; cached reads are reported out of the prompt total', async () => {
    googleGenerateContentStream.mockImplementation(async () => googleStreamResult({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4096, candidatesTokenCount: 7 },
    }));
    const ex = new GoogleExecutor(config('google', 'gemini-3.8-flash', { prompt_cache_key: 'agnt-lane', prompt_cache_breakpoints: false, temperature: 0.1 }, { google: { apiKey: 'k' } }));
    const res = await ex.invoke(MSGS, {});
    const cfg = getGenerativeModel.mock.calls[0][0];
    expect(cfg.prompt_cache_key).toBeUndefined();
    expect(cfg.prompt_cache_breakpoints).toBeUndefined();
    expect(cfg.temperature).toBe(0.1);
    expect(res.usage).toMatchObject({ input_tokens: 904, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 });
  });
});

/**
 * Structured executor failure: execute() keeps `error` (message string) and
 * additionally returns `failure: { kind, status, provider, model, fallbackTrail }`
 * derived from TYPED provider errors — never message text. Every message below
 * is deliberately misleading or non-English to prove that.
 */

import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import AnthropicExecutor from '../providers/anthropic.js';
import AzureFoundryExecutor from '../providers/azureFoundry.js';
import OpenAICompatibleExecutor from '../providers/openaiCompatible.js';
import { classifyError } from '../failure.js';
import { StreamAbortError } from '../providers/streaming.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function manifest(models: Array<{ provider: string; model: string }>): PromptManifestV2 {
  return {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json', kind: 'PromptManifest', apiVersion: 'v2',
    metadata: { name: 't', title: 'T', description: '' },
    spec: {
      routingStrategy: 'fallback', enableToolCalls: false, variables: [], files: [], tools: [],
      models: models.map((m, i) => ({ ...m, fallbackOrder: i })) as any, dependencies: [],
    },
  };
}
function cfg(m: PromptManifestV2): BaseExecutorConfig {
  return { manifest: m, credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent' } as BaseExecutorConfig;
}
class TestExecutor extends BaseExecutor {
  invoke = vi.fn();
  hasToolCalls = vi.fn().mockReturnValue(false);
}
const OK = { message: { role: 'assistant', content: 'ok' }, usage: { input_tokens: 1, output_tokens: 1 } };

// Real SDK errors (typed classes + bodies), with non-English/misleading messages.
const anthropicErr = (status: number, type: string, msg = 'いいえ') =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message: msg } }, msg, new Headers());
const openaiErr = (status: number, code: string | null, msg = 'nein') =>
  OpenAI.APIError.generate(status, { error: { code, message: msg, type: 'x' } }, msg, new Headers());
const named = (name: string, props: Record<string, any> = {}) => {
  const C = { [name]: class extends Error {} }[name];
  return Object.assign(new C('¿?'), props);
};

describe('classifyError — kind per provider shape', () => {
  const cases: Array<[string, any, string, number | undefined]> = [
    // quota
    ['anthropic 429 (RateLimitError class)', anthropicErr(429, 'rate_limit_error'), 'quota', 429],
    ['openai 429 insufficient_quota', openaiErr(429, 'insufficient_quota'), 'quota', 429],
    ['azure foundry 429 RateLimitReached', openaiErr(429, 'RateLimitReached'), 'quota', 429],
    ['azure/foundry code without status (TooManyRequests)', { code: 'TooManyRequests' }, 'quota', undefined],
    ['kimi 429 exceeded_current_quota_error', Object.assign(new Error('额度'), { status: 429, error: { type: 'exceeded_current_quota_error' } }), 'quota', 429],
    ['kimi type rate_limit_reached_error, no status', { error: { type: 'rate_limit_reached_error' } }, 'quota', undefined],
    ['anthropic body type rate_limit_error surfaced as 200-ish stream error', { error: { error: { type: 'rate_limit_error' } } }, 'quota', undefined],
    ['google RESOURCE_EXHAUSTED string status', { status: 'RESOURCE_EXHAUSTED' }, 'quota', undefined],
    ['bedrock ThrottlingException', named('ThrottlingException', { $metadata: { httpStatusCode: 400 } }), 'quota', 400],
    ['status nested on cause', { cause: { status: 429 } }, 'quota', 429],
    // timeout
    ['StreamAbortError idle', new StreamAbortError('idle', 'x'), 'timeout', undefined],
    ['StreamAbortError backstop', new StreamAbortError('backstop', 'x'), 'timeout', undefined],
    ['anthropic APIConnectionTimeoutError', new Anthropic.APIConnectionTimeoutError(), 'timeout', undefined],
    ['openai APIConnectionTimeoutError', new OpenAI.APIConnectionTimeoutError(), 'timeout', undefined],
    ['408', anthropicErr(408, 'timeout_error'), 'timeout', 408],
    ['ETIMEDOUT node code', Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'timeout', undefined],
    // aborted
    ['StreamAbortError external', new StreamAbortError('external', 'x'), 'aborted', undefined],
    ['anthropic APIUserAbortError', new Anthropic.APIUserAbortError(), 'aborted', undefined],
    ['AbortError name', named('AbortError'), 'aborted', undefined],
    // unsupported
    ['501 not implemented', anthropicErr(501, 'api_error'), 'unsupported', 501],
    ['openai 400 unsupported_parameter', openaiErr(400, 'unsupported_parameter'), 'unsupported', 400],
    ['azure 404 DeploymentNotFound', openaiErr(404, 'DeploymentNotFound'), 'unsupported', 404],
    ['azure OperationNotSupported', openaiErr(400, 'OperationNotSupported'), 'unsupported', 400],
    // provider_error
    ['anthropic 529 overloaded', anthropicErr(529, 'overloaded_error'), 'provider_error', 529],
    ['openai 500', openaiErr(500, null), 'provider_error', 500],
    ['502 (empty-response synthetic)', Object.assign(new Error('x'), { status: 502 }), 'provider_error', 502],
    ['ECONNRESET', Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'provider_error', undefined],
    ['anthropic APIConnectionError', new Anthropic.APIConnectionError({ message: 'x' }), 'provider_error', undefined],
    // bad_request
    ['anthropic 400 invalid_request_error', anthropicErr(400, 'invalid_request_error'), 'bad_request', 400],
    ['openai 401', openaiErr(401, 'invalid_api_key'), 'bad_request', 401],
    ['openai 422', openaiErr(422, null), 'bad_request', 422],
    // unknown
    ['plain Error', new Error('rate limit exceeded, quota, timeout'), 'unknown', undefined],
    ['bare string', 'oops', 'unknown', undefined],
    ['undefined', undefined, 'unknown', undefined],
  ];
  it.each(cases)('%s -> %s', (_n, err, kind, status) => {
    expect(classifyError(err)).toEqual({ kind, status });
  });

  it('never keys on message text (quota/timeout wording in a plain Error stays unknown)', () => {
    for (const m of ['429 Too Many Requests', 'Request timed out', 'rate limit', 'quota exceeded', 'Überlastet']) {
      expect(classifyError(new Error(m)).kind).toBe('unknown');
    }
  });

  it('cancelled wins over everything', () => {
    expect(classifyError(anthropicErr(429, 'rate_limit_error'), { cancelled: true }).kind).toBe('aborted');
  });
});

describe('execute() failure result', () => {
  it('keeps `error` as the message string and adds `failure`', async () => {
    const ex = new TestExecutor(cfg(manifest([{ provider: 'openai', model: 'gpt-x' }]))) as any;
    ex.invoke.mockRejectedValue(openaiErr(429, 'rate_limit_exceeded', 'この文言は無関係'));
    const r = await ex.execute();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('429 この文言は無関係'); // SDK-formatted message, unchanged
    expect(r.failure).toEqual({
      kind: 'quota', status: 429, provider: 'openai', model: 'gpt-x',
      fallbackTrail: [{ provider: 'openai', model: 'gpt-x', kind: 'quota', status: 429 }],
    });
  });

  it('successful result has no failure', async () => {
    const ex = new TestExecutor(cfg(manifest([{ provider: 'openai', model: 'a' }]))) as any;
    ex.invoke.mockResolvedValue(OK);
    const r = await ex.execute();
    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
  });

  it('fallbackTrail lists every member with its own kind/status; failure is the last member', async () => {
    const ex = new TestExecutor({
      ...cfg(manifest([
        { provider: 'azureFoundry', model: 'm1' },
        { provider: 'anthropic', model: 'm2' },
        { provider: 'kimi', model: 'm3' },
      ])),
      // cross-provider hops delegate to a provider-correct executor; route them all to the same stub
      executorFactory: async () => ({ invoke: (...a: any[]) => ex.invoke(...a) }),
    } as any) as any;
    ex.invoke
      .mockRejectedValueOnce(openaiErr(429, 'RateLimitReached'))
      .mockRejectedValueOnce(anthropicErr(529, 'overloaded_error'))
      .mockRejectedValueOnce(new StreamAbortError('idle', 'x'));
    const r = await ex.execute();
    expect(r.failure.kind).toBe('timeout');
    expect(r.failure.provider).toBe('kimi');
    expect(r.failure.model).toBe('m3');
    expect(r.failure.fallbackTrail).toEqual([
      { provider: 'azureFoundry', model: 'm1', kind: 'quota', status: 429 },
      { provider: 'anthropic', model: 'm2', kind: 'provider_error', status: 529 },
      { provider: 'kimi', model: 'm3', kind: 'timeout', status: undefined },
    ]);
    // legacy raw trail + message repair untouched
    expect(r.error).toContain('all 3 models failed');
  });

  it('all-429 chain: trail shows only quota (Reviewer can count it as quota even if final kind differs)', async () => {
    const ex = new TestExecutor(cfg(manifest([
      { provider: 'azureFoundry', model: 'a' }, { provider: 'azureFoundry', model: 'b' },
    ]))) as any;
    ex.invoke.mockRejectedValue(openaiErr(429, null));
    const r = await ex.execute();
    expect(r.failure.kind).toBe('quota');
    expect(r.failure.fallbackTrail.map((t: any) => t.kind)).toEqual(['quota', 'quota']);
  });

  it('unsupported (HTTP 400 typed unsupported_parameter) is distinct from plain bad_request', async () => {
    const ex = new TestExecutor(cfg(manifest([{ provider: 'anthropic', model: 'a' }]))) as any;
    ex.invoke.mockRejectedValue(openaiErr(400, 'unsupported_parameter'));
    expect((await ex.execute()).failure.kind).toBe('unsupported');
    ex.invoke.mockRejectedValue(anthropicErr(400, 'invalid_request_error'));
    expect((await ex.execute()).failure.kind).toBe('bad_request');
  });

  it('caller stop -> aborted, and no fan-out to later members', async () => {
    const ex = new TestExecutor(cfg(manifest([
      { provider: 'anthropic', model: 'a' }, { provider: 'anthropic', model: 'b' },
    ]))) as any;
    ex.invoke.mockImplementation(async () => { ex.cancel(); throw new Anthropic.APIUserAbortError(); });
    const r = await ex.execute();
    expect(ex.invoke).toHaveBeenCalledTimes(1);
    expect(r.failure.kind).toBe('aborted');
    expect(r.failure.fallbackTrail).toHaveLength(1);
  });

  it('a non-fallback-eligible external abort surfaces as aborted', async () => {
    const ex = new TestExecutor(cfg(manifest([
      { provider: 'anthropic', model: 'a' }, { provider: 'anthropic', model: 'b' },
    ]))) as any;
    ex.invoke.mockRejectedValue(new StreamAbortError('external', 'x'));
    const r = await ex.execute();
    expect(ex.invoke).toHaveBeenCalledTimes(1);
    expect(r.failure.kind).toBe('aborted');
  });

  it('error thrown outside model invocation still yields a failure (unknown, primary provider/model)', async () => {
    const m = manifest([{ provider: 'anthropic', model: 'a' }]);
    m.spec.variables = [{ key: 'need', required: true } as any];
    const ex = new TestExecutor(cfg(m)) as any;
    const r = await ex.execute();
    expect(r.ok).toBe(false);
    expect(r.failure).toEqual({ kind: 'unknown', status: undefined, provider: 'anthropic', model: 'a', fallbackTrail: [] });
  });
});

describe('real provider executors surface typed failures through execute()', () => {
  const m = (provider: string, model: string) => manifest([{ provider, model }]);
  const msgs = [{ role: 'user', content: 'hi' }];

  it('anthropic: SDK 429 RateLimitError -> quota', async () => {
    const ex = new AnthropicExecutor({ manifest: m('anthropic', 'claude-x'), credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent', messages: msgs } as any) as any;
    ex.client.messages.stream = () => { throw anthropicErr(429, 'rate_limit_error'); };
    const r = await ex.execute();
    expect(r.failure).toMatchObject({ kind: 'quota', status: 429, provider: 'anthropic', model: 'claude-x' });
  });

  it('anthropic: 400 invalid_request_error (thinking + forced tool shape) -> bad_request, not quota', async () => {
    const ex = new AnthropicExecutor({ manifest: m('anthropic', 'claude-x'), credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent', messages: msgs } as any) as any;
    ex.client.messages.stream = () => { throw anthropicErr(400, 'invalid_request_error', 'quota rate limit timeout'); };
    const r = await ex.execute();
    expect(r.failure).toMatchObject({ kind: 'bad_request', status: 400 });
  });

  it('azure foundry: 429 -> quota', async () => {
    const ex = new AzureFoundryExecutor({
      manifest: m('azureFoundry', 'kimi-k2'), credentials: { azureFoundry: { apiKey: 'k', endpoint: 'https://x.services.ai.azure.com' } },
      logLevel: 'silent', messages: msgs,
    } as any) as any;
    ex.client.chat.completions.create = async () => { throw openaiErr(429, 'RateLimitReached'); };
    const r = await ex.execute();
    expect(r.failure).toMatchObject({ kind: 'quota', status: 429, provider: 'azureFoundry', model: 'kimi-k2' });
  });

  it('openai-compatible (kimi/together): 429 -> quota; 503 -> provider_error', async () => {
    const ex = new OpenAICompatibleExecutor({
      manifest: m('together', 'moonshotai/Kimi-K2'), credentials: { together: { apiKey: 'k' } }, logLevel: 'silent', messages: msgs,
    } as any) as any;
    ex.client.chat.completions.create = async () => { throw openaiErr(429, 'exceeded_current_quota_error'); };
    expect((await ex.execute()).failure).toMatchObject({ kind: 'quota', status: 429 });
    ex.client.chat.completions.create = async () => { throw openaiErr(503, null); };
    expect((await ex.execute()).failure).toMatchObject({ kind: 'provider_error', status: 503 });
  });
});

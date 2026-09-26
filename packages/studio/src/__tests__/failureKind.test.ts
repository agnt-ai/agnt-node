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
import { classifyError, buildFailure } from '../failure.js';
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
    ['openai 401 (auth)', openaiErr(401, 'invalid_api_key'), 'auth', 401],
    ['openai 422', openaiErr(422, null), 'bad_request', 422],
    // unknown
    ['plain Error', new Error('rate limit exceeded, quota, timeout'), 'unknown', undefined],
    ['bare string', 'oops', 'unknown', undefined],
    ['undefined', undefined, 'unknown', undefined],
  ];
  it.each(cases)('%s -> %s', (_n, err, kind, status) => {
    const c = classifyError(err);
    expect({ kind: c.kind, status: c.status }).toEqual({ kind, status });
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
      kind: 'quota', status: 429, provider: 'openai', model: 'gpt-x', retryable: true,
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

  it('non-eligible abort on a later member keeps the earlier members in the trail', async () => {
    const ex = new TestExecutor(cfg(manifest([
      { provider: 'anthropic', model: 'a' }, { provider: 'anthropic', model: 'b' },
    ]))) as any;
    ex.invoke
      .mockRejectedValueOnce(openaiErr(429, null))
      .mockRejectedValueOnce(new StreamAbortError('backstop', 'x'));
    const r = await ex.execute();
    expect(r.failure.kind).toBe('timeout');
    expect(r.failure.fallbackTrail).toEqual([
      { provider: 'anthropic', model: 'a', kind: 'quota', status: 429 },
      { provider: 'anthropic', model: 'b', kind: 'timeout', status: undefined },
    ]);
  });

  it('a 429-shaped error thrown after the caller stopped is aborted (in failure and in the trail)', async () => {
    const ex = new TestExecutor(cfg(manifest([{ provider: 'anthropic', model: 'a' }]))) as any;
    ex.invoke.mockImplementation(async () => { ex.cancel(); throw openaiErr(429, null); });
    const r = await ex.execute();
    expect(r.failure.kind).toBe('aborted');
    expect(r.failure.fallbackTrail[0].kind).toBe('aborted');
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

describe('classifyError — names, cause chain, ordering', () => {
  const k = (e: any, o?: any) => classifyError(e, o).kind;

  it('reads `.name` too: DOMException-style and smithy plain Errors, and minified class names', () => {
    expect(k(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('aborted');
    expect(k(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(k(Object.assign(new Error('x'), { name: 'ThrottlingException' }))).toBe('quota');
    class e extends Error {}
    expect(k(Object.assign(new e('x'), { name: 'RateLimitError' }))).toBe('quota');
  });

  it('reads Node codes through the cause chain (Node fetch failed TypeError)', () => {
    const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('c'), { code }) });
    expect(k(fetchFailed('ETIMEDOUT'))).toBe('timeout');
    expect(k(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
    expect(k(fetchFailed('ECONNRESET'))).toBe('provider_error');
    expect(k(fetchFailed('ENOTFOUND'))).toBe('provider_error');
    expect(k(fetchFailed('UND_ERR_SOCKET'))).toBe('provider_error');
    // TLS/certificate failures are deliberately left unknown
    expect(k(fetchFailed('CERT_HAS_EXPIRED'))).toBe('unknown');
    expect(k(fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('unknown');
  });

  it('a StreamAbortError in the cause chain is honoured', () => {
    expect(k(Object.assign(new Error('wrapper'), { cause: new StreamAbortError('external', 'x') }))).toBe('aborted');
    expect(k(Object.assign(new Error('wrapper'), { cause: new StreamAbortError('idle', 'x') }))).toBe('timeout');
  });

  it('quota is checked before timeout: a 408 / timeout-class error carrying a quota signal is quota', () => {
    expect(k(Object.assign(new Error('x'), { status: 408, code: 'rate_limit_exceeded' }))).toBe('quota');
    expect(k(Object.assign(new Error('x'), { name: 'TimeoutError', status: 429 }))).toBe('quota');
    expect(k(Object.assign(new Error('x'), { code: 'ETIMEDOUT', status: 429 }))).toBe('quota');
  });

  it('auth: 401/403, auth classes and AccessDenied codes (not bad_request)', () => {
    expect(k(openaiErr(401, 'invalid_api_key'))).toBe('auth');
    expect(k(anthropicErr(403, 'permission_error'))).toBe('auth');
    expect(k(new Anthropic.AuthenticationError(401, undefined, 'x', new Headers()))).toBe('auth');
    expect(k(new OpenAI.PermissionDeniedError(403, undefined, 'x', new Headers()))).toBe('auth');
    expect(k(named('AccessDeniedException', { $metadata: { httpStatusCode: 400 } }))).toBe('auth');
    expect(k({ code: 'AccessDenied' })).toBe('auth');
    expect(k(Object.assign(new Error('x'), { status: 401 }))).toBe('auth'); // bare status
    expect(k(Object.assign(new Error('x'), { status: 403 }))).toBe('auth');
    // quota still wins over auth statuses
    expect(k(openaiErr(403, 'insufficient_quota'))).toBe('quota');
  });

  it('402: no code = bad_request; with a quota code = quota', () => {
    expect(k(Object.assign(new Error('x'), { status: 402 }))).toBe('bad_request');
    expect(k(Object.assign(new Error('x'), { status: 402, error: { type: 'exceeded_current_quota_error' } }))).toBe('quota');
  });

  it('a 400 with no code (e.g. Azure "no deployments ready") is bad_request: SDK never reads message text', () => {
    expect(k(Object.assign(new Error('No deployments ready'), { status: 400 }))).toBe('bad_request');
  });

  it('retryable hint: transient vs permanent', () => {
    const r = (e: any) => classifyError(e).retryable;
    expect(r(openaiErr(429, 'rate_limit_exceeded'))).toBe(true);
    expect(r(openaiErr(429, 'insufficient_quota'))).toBe(false);
    expect(r(Object.assign(new Error('x'), { status: 429, error: { type: 'exceeded_current_quota_error' } }))).toBe(false);
    expect(r(anthropicErr(529, 'overloaded_error'))).toBe(true);
    expect(r(new StreamAbortError('idle', 'x'))).toBe(true);
    expect(r(openaiErr(401, 'invalid_api_key'))).toBe(false);
    expect(r(anthropicErr(400, 'invalid_request_error'))).toBe(false);
    expect(r(openaiErr(501, null))).toBe(false);
    expect(r(new StreamAbortError('external', 'x'))).toBe(false);
    expect(r(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(r(new Error('x'))).toBeUndefined();
  });
});

describe('tool errors are not LLM errors', () => {
  class LoopExecutor extends BaseExecutor {
    hasToolCalls(m: any) { return !!m?.tool_calls?.length; }
    invoke = vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'flaky', args: {} }] },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  const mk = (status: number) => {
    const m = manifest([{ provider: 'anthropic', model: 'a' }]);
    m.spec.enableToolCalls = true;
    m.spec.tools = [{ name: 'flaky', description: 'd', parameters: { type: 'object', properties: {} } } as any];
    const handler = { execute: vi.fn().mockRejectedValue(Object.assign(new Error('upstream'), { status })) };
    const ex = new LoopExecutor({ ...cfg(m), toolRouter: { flaky: handler } } as any) as any;
    return { ex, handler };
  };

  it.each([429, 408, 503])('a tool handler error with .status %i rethrown after 3 strikes is unknown, not quota/timeout/provider_error', async (status) => {
    const { ex, handler } = mk(status);
    const r = await ex.execute();
    expect(handler.execute.mock.calls.length).toBeGreaterThanOrEqual(3); // really went through the tool loop
    expect(r.ok).toBe(false);
    expect(r.error).toBe('upstream');
    expect(r.failure.kind).toBe('unknown');
    expect(r.failure.status).toBeUndefined();
    expect(r.failure.fallbackTrail).toEqual([]);
    expect(r.failure.retryable).toBeUndefined();
  });

  it('cancelled + no trail = aborted; a cancel that does not throw has no failure', async () => {
    expect(buildFailure(Object.assign(new Error('x'), { status: 429 }), {}, { cancelled: true }))
      .toMatchObject({ kind: 'aborted', retryable: false });
    const ex = new TestExecutor(cfg(manifest([{ provider: 'anthropic', model: 'a' }]))) as any;
    ex.invoke.mockImplementation(async () => { ex.cancel(); return OK; });
    const r = await ex.execute();
    expect(r.ok).toBe(false);
    expect(r.failure).toBeUndefined();
  });
});

describe('success keeps the trail', () => {
  const two = () => new TestExecutor(cfg(manifest([
    { provider: 'anthropic', model: 'a' }, { provider: 'anthropic', model: 'b' },
  ]))) as any;

  it('quota then success: ok:true with the failed member in fallbackTrail', async () => {
    const ex = two();
    ex.invoke.mockRejectedValueOnce(openaiErr(429, 'RateLimitReached')).mockResolvedValueOnce(OK);
    const r = await ex.execute();
    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.fallbackTrail).toEqual([{ provider: 'anthropic', model: 'a', kind: 'quota', status: 429 }]);
  });

  it('first member succeeds: no fallbackTrail key at all', async () => {
    const ex = two();
    ex.invoke.mockResolvedValueOnce(OK);
    const r = await ex.execute();
    expect(r.ok).toBe(true);
    expect('fallbackTrail' in r).toBe(false);
  });

  it('trail does not leak between execute() calls on the same executor', async () => {
    const ex = two();
    ex.invoke.mockRejectedValueOnce(openaiErr(429, null)).mockResolvedValueOnce(OK).mockResolvedValueOnce(OK);
    expect((await ex.execute()).fallbackTrail).toHaveLength(1);
    const r2 = await ex.execute();
    expect(r2.ok).toBe(true);
    expect('fallbackTrail' in r2).toBe(false);
  });

  it('tool-call result path (no router) carries the trail too', async () => {
    const m = manifest([{ provider: 'anthropic', model: 'a' }, { provider: 'anthropic', model: 'b' }]);
    m.spec.enableToolCalls = true;
    m.spec.tools = [{ name: 'out', description: 'd', parameters: { type: 'object', properties: {} } } as any];
    const ex = new TestExecutor(cfg(m)) as any;
    ex.invoke.mockRejectedValueOnce(openaiErr(429, null)).mockResolvedValueOnce({
      message: { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'out', args: { a: 1 } }] }, usage: {},
    });
    const r = await ex.execute();
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ a: 1 });
    expect(r.fallbackTrail).toEqual([{ provider: 'anthropic', model: 'a', kind: 'quota', status: 429 }]);
  });

  it('cross-provider success also carries the trail', async () => {
    const ex = new TestExecutor({
      ...cfg(manifest([{ provider: 'azureFoundry', model: 'a' }, { provider: 'kimi', model: 'b' }])),
      executorFactory: async () => ({ invoke: async () => OK }),
    } as any) as any;
    ex.invoke.mockRejectedValueOnce(openaiErr(429, null));
    const r = await ex.execute();
    expect(r.ok).toBe(true);
    expect(r.fallbackTrail).toEqual([{ provider: 'azureFoundry', model: 'a', kind: 'quota', status: 429 }]);
  });

  it('a member skipped for lack of an executorFactory is recorded as unsupported; failure names the member actually tried', async () => {
    const ex = new TestExecutor(cfg(manifest([
      { provider: 'anthropic', model: 'a' }, { provider: 'openai', model: 'b' },
    ]))) as any; // no executorFactory: cross-provider hop skipped
    ex.invoke.mockRejectedValueOnce(openaiErr(429, null));
    const r = await ex.execute();
    expect(r.ok).toBe(false);
    expect(r.failure.kind).toBe('quota');
    expect(r.failure.provider).toBe('anthropic');
    expect(r.failure.model).toBe('a');
    expect(r.failure.fallbackTrail).toEqual([
      { provider: 'anthropic', model: 'a', kind: 'quota', status: 429 },
      { provider: 'openai', model: 'b', kind: 'unsupported' },
    ]);
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

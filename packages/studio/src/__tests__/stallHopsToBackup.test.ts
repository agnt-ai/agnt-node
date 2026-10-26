/**
 * A slow model hands the turn to the account's next model instead of eating the
 * caller's time (2026-10-19: one model slowed down for everyone, its backup stayed
 * healthy, and turns sat out three idle stalls or the full backstop on the slow one
 * until the worker's Lambda killed the run).
 *
 * Driven end to end through a real adapter (OpenAIExecutor, chat completions) and
 * BaseExecutor.invokeWithFallback, with the provider SDK mocked to stall, dribble,
 * or answer. Idle and backstop thresholds are shrunk through their env overrides,
 * which streaming.ts reads at import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.AGNT_STREAM_IDLE_TIMEOUT_MS = '40';
  process.env.AGNT_STREAM_BACKSTOP_MS = '200';
});

const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return { chat: { completions: { create: openaiCreate } } }; }),
}));

import OpenAIExecutor from '../providers/openai.js';
import { StreamAbortError } from '../providers/streaming.js';
import { openAIStreamFromCompletion } from './_streamMocks.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function config(models: string[], extra: Partial<BaseExecutorConfig> = {}): BaseExecutorConfig {
  const manifest: PromptManifestV2 = {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest',
    apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: {
      routingStrategy: 'fallback', enableToolCalls: false, variables: [], files: [], tools: [],
      models: models.map((model, i) => ({ provider: 'openai', model, fallbackOrder: i })),
      dependencies: [],
    },
  };
  return { manifest, credentials: { openai: { apiKey: 'k' } }, logLevel: 'silent', ...extra } as BaseExecutorConfig;
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** No token, ever: rejects only when the request is aborted. */
function stalled(signal: AbortSignal): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    },
  };
}

/** A token every 10 ms, forever: never idle, only the ceiling stops it. */
function dribbling(signal: AbortSignal): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (signal.aborted) throw abortError();
        yield { choices: [{ index: 0, delta: { content: '.' } }] };
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

const answer = () => openAIStreamFromCompletion({
  choices: [{ message: { role: 'assistant', content: 'from backup' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

/** Each model's behaviour, keyed by the model the request names. */
function serve(byModel: Record<string, (signal: AbortSignal) => AsyncIterable<any>>) {
  openaiCreate.mockImplementation(async (params: any, { signal }: { signal: AbortSignal }) => byModel[params.model](signal));
}

const callsFor = (model: string) => openaiCreate.mock.calls.filter(([p]) => p.model === model).length;
const hi = [{ role: 'user', content: 'hi' }];

beforeEach(() => vi.clearAllMocks());

describe('a stalled model hands the turn to the next configured model', () => {
  it('moves on at the FIRST idle stall when a backup follows (one attempt, not three)', async () => {
    serve({ primary: stalled, backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'])) as any;

    const res = await ex.invokeWithFallback(hi, {});

    expect(res.message.content).toBe('from backup');
    expect(callsFor('primary')).toBe(1);
    expect(callsFor('backup')).toBe(1);
  });

  it('the last model in the list keeps its in-place stall retries (an account with no backup is no worse off)', async () => {
    serve({ only: stalled });
    const ex = new OpenAIExecutor(config(['only'])) as any;

    const err = await ex.invokeWithFallback(hi, {}).catch((e: any) => e);

    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('idle');
    expect(callsFor('only')).toBe(3);
  });

  it('a stream that dribbles to the backstop moves to the next model instead of ending the turn', async () => {
    serve({ primary: dribbling, backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'])) as any;

    const res = await ex.invokeWithFallback(hi, {});

    expect(res.message.content).toBe('from backup');
    expect(callsFor('primary')).toBe(1);
    expect(callsFor('backup')).toBe(1);
  });
});

describe('the caller\'s deadline bounds every attempt and ends the hops', () => {
  it('an attempt still running at the deadline stops with reason "deadline", and no other model is tried', async () => {
    serve({ primary: dribbling, backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'], { deadlineAt: Date.now() + 60 })) as any;

    const started = Date.now();
    const err = await ex.invokeWithFallback(hi, {}).catch((e: any) => e);

    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('deadline');
    // Stopped at the deadline, well before the 200 ms backstop.
    expect(Date.now() - started).toBeLessThan(180);
    expect(callsFor('primary')).toBe(1);
    expect(callsFor('backup')).toBe(0);
  });

  it('a per-call deadlineAt works the same as the executor-level one', async () => {
    serve({ primary: dribbling, backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'])) as any;

    const err = await ex.invokeWithFallback(hi, { deadlineAt: Date.now() + 60 }).catch((e: any) => e);

    expect(err.reason).toBe('deadline');
    expect(callsFor('backup')).toBe(0);
  });

  it('a stall that lands after the deadline has passed does not hop', async () => {
    // The primary stalls (40 ms idle) after the deadline (20 ms) is already gone:
    // the ceiling fires first as "deadline". Even a fallback-eligible failure
    // reaching the loop past the deadline would stop there (see the next test).
    serve({ primary: stalled, backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'], { deadlineAt: Date.now() + 20 })) as any;

    const err = await ex.invokeWithFallback(hi, {}).catch((e: any) => e);

    expect(err.reason).toBe('deadline');
    expect(callsFor('backup')).toBe(0);
  });

  it('past the deadline no model is called at all', async () => {
    serve({ primary: () => answer(), backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'], { deadlineAt: Date.now() - 1 })) as any;

    const err = await ex.invokeWithFallback(hi, {}).catch((e: any) => e);

    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('deadline');
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('an error surfacing after the deadline is reported as the deadline, with the cause kept', async () => {
    // Primary fails with an ordinary (fallback-eligible) error just after the deadline.
    openaiCreate.mockImplementation(async (params: any) => {
      if (params.model === 'primary') {
        await new Promise((r) => setTimeout(r, 30));
        throw Object.assign(new Error('bad gateway'), { status: 400 });
      }
      return answer();
    });
    const ex = new OpenAIExecutor(config(['primary', 'backup'], { deadlineAt: Date.now() + 15 })) as any;

    const err = await ex.invokeWithFallback(hi, {}).catch((e: any) => e);

    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('deadline');
    expect(err.cause?.message).toBe('bad gateway');
    expect(callsFor('backup')).toBe(0);
  });
});

describe('a caller stop stays terminal', () => {
  it('an external abort mid-stream is not retried and fans out to no other model', async () => {
    serve({ primary: dribbling, backup: () => answer() });
    const ex = new OpenAIExecutor(config(['primary', 'backup'])) as any;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);

    const err = await ex.invokeWithFallback(hi, { signal: stop.signal }).catch((e: any) => e);

    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('external');
    expect(callsFor('primary')).toBe(1);
    expect(callsFor('backup')).toBe(0);
  });
});

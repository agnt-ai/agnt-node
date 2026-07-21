/**
 * Unit tests for the streaming orchestration helpers (provider-agnostic):
 * the idle/backstop/external abort guard, the whole-prompt retry wrapper, and
 * the OpenAI-compatible stream assembler.
 *
 * Real timers with small thresholds — the guard's whole job is timing, so we
 * exercise the actual setTimeout paths rather than mocking them away.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createStreamGuard,
  streamWithRetry,
  consumeOpenAIStream,
  consumeOpenAIResponsesStream,
  StreamAbortError,
} from '../streaming.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An attempt that rejects like a provider SDK the moment the guard aborts. */
function abortsOnGuard(guard: { signal: AbortSignal }): Promise<never> {
  return new Promise((_, reject) => {
    if (guard.signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    guard.signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
}

describe('createStreamGuard', () => {
  it('aborts with reason "idle" when no token arrives within the idle window', async () => {
    const g = createStreamGuard({ idleTimeoutMs: 30, backstopMs: 10_000 });
    expect(g.signal.aborted).toBe(false);
    await sleep(60);
    expect(g.signal.aborted).toBe(true);
    expect(g.reason()).toBe('idle');
    g.dispose();
  });

  it('bump() keeps a steadily-progressing stream alive past the idle window', async () => {
    const g = createStreamGuard({ idleTimeoutMs: 40, backstopMs: 10_000 });
    // Bump every 15ms for ~90ms — comfortably inside the 40ms idle window each time.
    for (let i = 0; i < 6; i++) {
      await sleep(15);
      g.bump();
    }
    expect(g.signal.aborted).toBe(false);
    expect(g.reason()).toBeNull();
    // Stop bumping → the idle timer finally fires.
    await sleep(60);
    expect(g.reason()).toBe('idle');
    g.dispose();
  });

  it('aborts with reason "backstop" even while tokens keep arriving', async () => {
    const g = createStreamGuard({ idleTimeoutMs: 10_000, backstopMs: 40 });
    // Bump aggressively — idle never trips, but the absolute backstop must.
    const stop = Date.now() + 200;
    while (Date.now() < stop && !g.signal.aborted) {
      g.bump();
      await sleep(10);
    }
    expect(g.signal.aborted).toBe(true);
    expect(g.reason()).toBe('backstop');
    g.dispose();
  });

  it('aborts with reason "external" when the caller signal fires', async () => {
    const ext = new AbortController();
    const g = createStreamGuard({ idleTimeoutMs: 10_000, backstopMs: 10_000, externalSignal: ext.signal });
    expect(g.signal.aborted).toBe(false);
    ext.abort();
    expect(g.signal.aborted).toBe(true);
    expect(g.reason()).toBe('external');
    g.dispose();
  });

  it('adopts an already-aborted external signal immediately', () => {
    const ext = new AbortController();
    ext.abort();
    const g = createStreamGuard({ externalSignal: ext.signal });
    expect(g.signal.aborted).toBe(true);
    expect(g.reason()).toBe('external');
    g.dispose();
  });

  it('dispose() cancels the pending idle/backstop timers', async () => {
    const g = createStreamGuard({ idleTimeoutMs: 20, backstopMs: 20 });
    g.dispose();
    await sleep(50);
    expect(g.signal.aborted).toBe(false);
    expect(g.reason()).toBeNull();
  });
});

describe('streamWithRetry', () => {
  it('returns the attempt result on success (single attempt)', async () => {
    const attempt = vi.fn(async () => 'done');
    const out = await streamWithRetry(attempt, { maxRetries: 3 });
    expect(out).toBe('done');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries an idle stall up to maxRetries, then throws StreamAbortError(idle)', async () => {
    let attempts = 0;
    const err = await streamWithRetry(
      (guard) => { attempts++; return abortsOnGuard(guard); },
      { maxRetries: 3, idleTimeoutMs: 20, backstopMs: 10_000 }
    ).catch((e) => e);
    expect(attempts).toBe(3);
    expect(err).toBeInstanceOf(StreamAbortError);
    expect((err as StreamAbortError).reason).toBe('idle');
  });

  it('does NOT retry a backstop abort (terminal)', async () => {
    let attempts = 0;
    const err = await streamWithRetry(
      (guard) => { attempts++; return abortsOnGuard(guard); },
      { maxRetries: 3, idleTimeoutMs: 10_000, backstopMs: 20 }
    ).catch((e) => e);
    expect(attempts).toBe(1);
    expect((err as StreamAbortError).reason).toBe('backstop');
  });

  it('does NOT retry an external abort and stops before running when pre-aborted', async () => {
    const ext = new AbortController();
    ext.abort();
    let attempts = 0;
    const err = await streamWithRetry(
      async () => { attempts++; return 'x'; },
      { maxRetries: 3, externalSignal: ext.signal }
    ).catch((e) => e);
    expect(attempts).toBe(0);
    expect((err as StreamAbortError).reason).toBe('external');
  });

  it('retries a caller-classified retryable (non-abort) error, then succeeds', async () => {
    let attempts = 0;
    const out = await streamWithRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw Object.assign(new Error('503'), { status: 503 });
        return 'recovered';
      },
      { maxRetries: 3, isRetryable: (e: any) => e?.status >= 500 }
    );
    expect(out).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('does NOT retry a non-retryable error (fails fast)', async () => {
    let attempts = 0;
    const err = await streamWithRetry(
      async () => { attempts++; throw Object.assign(new Error('400'), { status: 400 }); },
      { maxRetries: 3, isRetryable: (e: any) => e?.status >= 500 }
    ).catch((e) => e);
    expect(attempts).toBe(1);
    expect((err as any).status).toBe(400);
  });

  it('a slow-but-progressing attempt (bumps within idle) does NOT time out', async () => {
    let attempts = 0;
    const out = await streamWithRetry(
      async (guard) => {
        attempts++;
        for (let i = 0; i < 5; i++) { await sleep(12); guard.bump(); }
        return 'streamed-ok';
      },
      { maxRetries: 3, idleTimeoutMs: 40, backstopMs: 10_000 }
    );
    expect(out).toBe('streamed-ok');
    expect(attempts).toBe(1);
  });
});

describe('consumeOpenAIStream', () => {
  async function* gen(chunks: any[]) {
    for (const c of chunks) yield c;
  }

  it('accumulates fragmented content and captures the final usage', async () => {
    let bumps = 0;
    const result = await consumeOpenAIStream(
      gen([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
        { choices: [{ index: 0, delta: { content: 'lo, ' } }] },
        { choices: [{ index: 0, delta: { content: 'world' } }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ]),
      () => { bumps++; }
    );
    expect(result.choices[0].message.content).toBe('Hello, world');
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
    expect(bumps).toBe(4); // bumped once per chunk
  });

  it('reassembles a tool call whose JSON arguments arrive in fragments', async () => {
    const result = await consumeOpenAIStream(
      gen([
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"wid' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'gets"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } },
      ]),
      () => {}
    );
    const tc = result.choices[0].message.tool_calls!;
    expect(tc).toHaveLength(1);
    expect(tc[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"widgets"}' } });
    // tool-only turn → content null (mirrors the non-streamed shape)
    expect(result.choices[0].message.content).toBeNull();
  });

  it('defaults a no-argument tool call to "{}" (never "") so JSON.parse is safe', async () => {
    const result = await consumeOpenAIStream(
      gen([
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', function: { name: 'ping' } }] } }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      () => {}
    );
    const tc = result.choices[0].message.tool_calls!;
    expect(tc[0].function.arguments).toBe('{}');
    expect(() => JSON.parse(tc[0].function.arguments)).not.toThrow();
  });

  it('accumulates delta.reasoning_content into a separate buffer, undefined when absent', async () => {
    const withReasoning = await consumeOpenAIStream(
      gen([
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'step ' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'by step' } }] },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 9 } },
      ]),
      () => {}
    );
    // content empty (no content deltas), reasoning accumulated separately
    expect(withReasoning.choices[0].message.content).toBe('');
    expect(withReasoning.choices[0].message.reasoning_content).toBe('step by step');

    // A stream that never sends reasoning_content leaves the field undefined.
    const withoutReasoning = await consumeOpenAIStream(
      gen([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] }]),
      () => {}
    );
    expect(withoutReasoning.choices[0].message.reasoning_content).toBeUndefined();
  });

  it('keeps multiple parallel tool calls separate by index, in order', async () => {
    const result = await consumeOpenAIStream(
      gen([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{"x":1}' } }] } }] },
      ]),
      () => {}
    );
    const tc = result.choices[0].message.tool_calls!;
    expect(tc.map((t) => t.id)).toEqual(['a', 'b']);
    expect(tc.map((t) => t.function.name)).toEqual(['one', 'two']);
  });
});

describe('consumeOpenAIResponsesStream', () => {
  async function* gen(events: any[]) {
    for (const e of events) yield e;
  }

  it('returns the terminal response and bumps once per event', async () => {
    let bumps = 0;
    const final = { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 2 } };
    const result = await consumeOpenAIResponsesStream(
      gen([
        { type: 'response.created', response: { status: 'in_progress' } },
        { type: 'response.output_text.delta', delta: 'hi' },
        { type: 'response.completed', response: final },
      ]),
      () => { bumps++; }
    );
    expect(bumps).toBe(3);
    expect(result).toBe(final);
  });

  it('returns a response.incomplete result as-is (partial, not an error)', async () => {
    const final = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
    const result = await consumeOpenAIResponsesStream(
      gen([{ type: 'response.incomplete', response: final }]),
      () => {}
    );
    expect(result).toBe(final);
  });

  it('throws on a failed response so the whole prompt can retry', async () => {
    await expect(
      consumeOpenAIResponsesStream(
        gen([{ type: 'response.failed', response: { status: 'failed', error: { message: 'boom' } } }]),
        () => {}
      )
    ).rejects.toThrow(/boom/);
  });

  it('throws when the stream ends without a terminal response event', async () => {
    await expect(
      consumeOpenAIResponsesStream(
        gen([{ type: 'response.output_text.delta', delta: 'x' }]),
        () => {}
      )
    ).rejects.toThrow(/without a terminal response event/);
  });
});

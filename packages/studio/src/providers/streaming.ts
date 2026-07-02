/**
 * streaming.ts — shared streaming orchestration for the provider adapters.
 *
 * WHY: model responses used to be awaited as a single non-streamed completion,
 * so the SDK's per-attempt `timeout` measured *total* time-to-complete. A
 * legitimately long-but-progressing response (a full slide deck, a long report)
 * could exceed that ceiling, get retried — re-sending the whole prompt and
 * re-billing each attempt — and eventually fail as "Request timed out".
 *
 * Streaming removes the ceiling: we consume the provider's token stream and
 * reset an INTER-CHUNK IDLE timer on every event. A response that keeps making
 * progress never times out no matter how long it runs; only a genuinely STALLED
 * stream (no token for `idleTimeoutMs`) is aborted and retried. A generous
 * ABSOLUTE BACKSTOP guards the pathological "one token every 59 s forever" case.
 *
 * This module owns the timeout/abort/retry *orchestration* (provider-agnostic).
 * Each provider adapter owns its SDK-specific stream consumption and assembles
 * the SAME final response object its non-streamed path produced — so the
 * executor's consumption (and token accounting) is byte-for-byte unchanged.
 */

/** No token for this long → the stream is stalled; abort + retry the attempt. */
export const STREAM_IDLE_TIMEOUT_MS =
  Number(process.env.AGNT_STREAM_IDLE_TIMEOUT_MS) || 60_000;

/** Absolute per-attempt ceiling. Only the pathological dribble case reaches it;
 *  a steadily-streaming multi-minute response never does. It is TERMINAL (not
 *  retried) so a misbehaving stream can't be retried 3× and blow the worker's
 *  14-min checkpoint. Comfortably above any legitimate single-turn duration. */
export const STREAM_ABSOLUTE_BACKSTOP_MS =
  Number(process.env.AGNT_STREAM_BACKSTOP_MS) || 600_000;

/** Whole-attempt retries on a transient mid-stream failure (idle stall, network
 *  drop, 5xx after the stream opened). Matches the pre-existing retry budget. */
export const STREAM_MAX_RETRIES = Number(process.env.AGNT_STREAM_MAX_RETRIES) || 3;

export type StreamAbortReason = 'idle' | 'backstop' | 'external';

/** Raised when the guard aborts a stream. `reason` decides retry policy:
 *  `idle` is transient (retry); `backstop` and `external` are terminal. */
export class StreamAbortError extends Error {
  reason: StreamAbortReason;
  constructor(reason: StreamAbortReason, message: string) {
    super(message);
    this.name = 'StreamAbortError';
    this.reason = reason;
  }
}

export interface StreamGuard {
  /** Pass to the provider SDK's stream call; aborts on idle/backstop/external. */
  readonly signal: AbortSignal;
  /** Call on every stream event/chunk to reset the idle timer. */
  bump(): void;
  /** Why the guard aborted, or null if it hasn't. */
  reason(): StreamAbortReason | null;
  /** Clear all timers + listeners. Idempotent; always call in a finally. */
  dispose(): void;
}

export interface StreamGuardOptions {
  idleTimeoutMs?: number;
  backstopMs?: number;
  /** The caller's AbortSignal (backend stop/timeout). Aborts the stream with
   *  reason `external` — terminal, never retried. */
  externalSignal?: AbortSignal;
}

function unref(t: any): void {
  // Don't let the idle/backstop timer keep the event loop (or a Lambda) alive.
  if (t && typeof t.unref === 'function') t.unref();
}

/**
 * Build an abort guard around a single stream attempt: an idle timer reset by
 * `bump()`, an absolute backstop, and linkage to an optional external signal.
 */
export function createStreamGuard(opts: StreamGuardOptions = {}): StreamGuard {
  const idleMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const backstopMs = opts.backstopMs ?? STREAM_ABSOLUTE_BACKSTOP_MS;
  const controller = new AbortController();
  let abortedReason: StreamAbortReason | null = null;
  let idleTimer: any = null;
  let backstopTimer: any = null;
  let externalCleanup: (() => void) | null = null;

  const abort = (reason: StreamAbortReason): void => {
    if (abortedReason) return; // first reason wins
    abortedReason = reason;
    clearTimers();
    controller.abort();
  };

  const clearTimers = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (backstopTimer) { clearTimeout(backstopTimer); backstopTimer = null; }
  };

  const bump = (): void => {
    if (abortedReason) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('idle'), idleMs);
    unref(idleTimer);
  };

  backstopTimer = setTimeout(() => abort('backstop'), backstopMs);
  unref(backstopTimer);

  if (opts.externalSignal) {
    const ext = opts.externalSignal;
    if (ext.aborted) {
      abort('external');
    } else {
      const onAbort = () => abort('external');
      ext.addEventListener('abort', onAbort, { once: true });
      externalCleanup = () => ext.removeEventListener('abort', onAbort);
    }
  }

  bump(); // arm the idle timer for the connection-open window

  return {
    signal: controller.signal,
    bump,
    reason: () => abortedReason,
    dispose: () => {
      clearTimers();
      if (externalCleanup) { externalCleanup(); externalCleanup = null; }
    },
  };
}

/** True for the abort error a provider SDK throws when we call `controller.abort()`. */
export function isAbortError(err: any): boolean {
  const name = err?.name ?? err?.constructor?.name;
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  return typeof err?.message === 'string' && /\baborted\b/i.test(err.message);
}

export interface StreamRetryOptions {
  maxRetries?: number;
  idleTimeoutMs?: number;
  backstopMs?: number;
  externalSignal?: AbortSignal;
  /** Classify a NON-abort mid-stream error as transient (retry) vs fatal. */
  isRetryable?: (err: any) => boolean;
  log?: (message: string) => void;
}

/**
 * Run one stream `attempt` with a fresh guard, retrying the WHOLE prompt on a
 * transient failure (idle stall or a caller-classified retryable error). The
 * partial output is discarded on failure. Backstop and external aborts are
 * terminal. Bounded by `maxRetries`.
 */
export async function streamWithRetry<T>(
  attempt: (guard: StreamGuard) => Promise<T>,
  opts: StreamRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? STREAM_MAX_RETRIES;
  const isRetryable = opts.isRetryable ?? (() => true);
  let lastError: any;

  for (let i = 0; i < maxRetries; i++) {
    if (opts.externalSignal?.aborted) {
      throw new StreamAbortError('external', '[streaming] aborted before attempt');
    }
    const guard = createStreamGuard({
      idleTimeoutMs: opts.idleTimeoutMs,
      backstopMs: opts.backstopMs,
      externalSignal: opts.externalSignal,
    });
    try {
      return await attempt(guard);
    } catch (err: any) {
      // Map a guard-triggered abort to a typed error carrying its reason.
      const reason = guard.reason();
      const mapped =
        reason && isAbortError(err)
          ? new StreamAbortError(reason, `[streaming] stream aborted: ${reason}`)
          : err;
      lastError = mapped;

      // Terminal: the caller asked to stop, or the stream dribbled to the
      // backstop — retrying either would be wrong/wasteful.
      if (mapped instanceof StreamAbortError && mapped.reason !== 'idle') {
        throw mapped;
      }
      const retryable =
        mapped instanceof StreamAbortError ? mapped.reason === 'idle' : isRetryable(mapped);
      if (!retryable || i === maxRetries - 1) throw mapped;
      opts.log?.(
        `[streaming] attempt ${i + 1}/${maxRetries} failed (${mapped?.message ?? mapped}) — discarding partial, retrying`
      );
    } finally {
      guard.dispose();
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible stream consumer (shared by OpenAI + DeepSeek adapters)
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of an OpenAI chat completion the executor consumes. Assembling
 *  the stream back into this shape lets the non-streamed extraction run
 *  unchanged. */
export interface OpenAICompletionLike {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: any;
}

/**
 * Fold an OpenAI (or OpenAI-compatible) chat completion STREAM back into the
 * non-streamed completion shape.
 *
 * Deltas arrive fragmented: `content` in pieces, and each tool call as an
 * index-keyed run of deltas — the id + function.name usually in the first, the
 * JSON `arguments` string across many. We reassemble per index and join in
 * index order. Usage arrives on the final chunk (requires
 * `stream_options.include_usage: true`).
 */
export async function consumeOpenAIStream(
  stream: AsyncIterable<any>,
  bump: () => void
): Promise<OpenAICompletionLike> {
  let role = 'assistant';
  let content = '';
  let sawContent = false;
  let usage: any = undefined;
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    bump();
    const choice = chunk?.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.role) role = delta.role;
      if (typeof delta.content === 'string') {
        content += delta.content;
        sawContent = true;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          let acc = byIndex.get(idx);
          if (!acc) { acc = { id: '', name: '', args: '' }; byIndex.set(idx, acc); }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
        }
      }
    }
    // Usage rides its own final chunk (choices may be empty there).
    if (chunk?.usage) usage = chunk.usage;
  }

  const tool_calls = byIndex.size
    ? [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        // Default empty args to "{}" — a zero-arg tool call may stream an id+name
        // with no `arguments` fragment (real OpenAI always sends "{}", but
        // DeepSeek / OpenAI-compatible endpoints may not). The downstream
        // extractor does JSON.parse(arguments), which throws on "". Mirror the
        // non-streamed shape so a no-arg tool call parses to {} instead of crashing.
        .map(([, v]) => ({ id: v.id, type: 'function' as const, function: { name: v.name, arguments: v.args || '{}' } }))
    : undefined;

  return {
    // Mirror the non-streamed shape: content is null when the turn is tool-only.
    choices: [{ message: { role, content: sawContent ? content : (tool_calls ? null : ''), tool_calls } }],
    usage,
  };
}

/**
 * failure.ts — structured classification of executor failures.
 *
 * WHY: BaseExecutor.execute() used to return only `error: error.message`,
 * dropping the provider error's HTTP status and the model-fallback trail, so a
 * caller could not tell a 429/quota error from a timeout or a schema failure
 * (and a 429 storm, retried by the provider client, streamWithRetry and the
 * member fallback, mostly surfaced as a timeout).
 *
 * RULES: `kind` is derived ONLY from typed signals — HTTP status codes, error
 * classes (constructor names), the typed StreamAbortError, Node error codes and
 * the provider's machine-readable error codes/types. NEVER from message text:
 * messages are localized/free-form and a word list is both brittle and
 * language-specific. Unknown shapes classify as `unknown`, not a guess.
 */

import { StreamAbortError } from './providers/streaming.js';
import type { ExecutorFailure, ExecutorFailureKind, FallbackTrailEntry } from './types.js';

/** Lowercase + strip non-alphanumerics so `rate_limit_exceeded`,
 *  `RateLimitExceeded` and `rate-limit-exceeded` compare equal. */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/** Machine-readable provider codes/types that mean quota / rate limit.
 *  OpenAI/Azure OpenAI/Foundry: rate_limit_exceeded, insufficient_quota,
 *  RateLimitReached, TooManyRequests. Anthropic: rate_limit_error.
 *  Kimi/Moonshot: rate_limit_reached_error, exceeded_current_quota_error.
 *  Google: RESOURCE_EXHAUSTED. Bedrock: ThrottlingException. */
const QUOTA_CODES = new Set([
  'ratelimitexceeded', 'ratelimitreached', 'ratelimiterror', 'ratelimitreachederror', 'ratelimited',
  'insufficientquota', 'quotaexceeded', 'exceededcurrentquotaerror', 'toomanyrequests',
  'resourceexhausted', 'throttlingexception', 'throttled', 'requestlimitexceeded', 'tokenratelimit',
]);

/** Error class names (constructor.name / .name) that mean quota. */
const QUOTA_CLASSES = new Set(['RateLimitError', 'ThrottlingException', 'TooManyRequestsError']);

/** Provider codes/types meaning "this model/parameter/endpoint is not supported". */
const UNSUPPORTED_CODES = new Set([
  'unsupportedparameter', 'unsupportedvalue', 'unsupportedmodel', 'unsupportedapiformodel',
  'operationnotsupported', 'notimplemented', 'notimplementederror', 'deploymentnotfound',
  'modelnotfound', 'unsupportedfeature',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED']);

const TIMEOUT_CLASSES = new Set(['APIConnectionTimeoutError', 'TimeoutError', 'RequestTimeoutError']);
const ABORT_CLASSES = new Set(['AbortError', 'APIUserAbortError', 'GoogleGenerativeAIAbortError']);
const NETWORK_CLASSES = new Set(['APIConnectionError', 'FetchError']);
const SERVER_CLASSES = new Set(['InternalServerError', 'OverloadedError', 'ServiceUnavailableException']);

function className(e: any): string {
  return e?.constructor?.name ?? e?.name ?? '';
}

/** Numeric HTTP status from the error itself or a provider wrapper (`response`,
 *  `$metadata`, `cause`). Google's `status` may be a string enum — handled as a code. */
export function extractStatus(err: any): number | undefined {
  const seen = new Set<any>();
  let cur = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 4 && !seen.has(cur); depth++) {
    seen.add(cur);
    for (const v of [cur.status, cur.statusCode, cur.response?.status, cur.$metadata?.httpStatusCode]) {
      if (typeof v === 'number' && v >= 100 && v <= 599) return v;
    }
    cur = cur.cause;
  }
  return undefined;
}

/** All machine-readable code/type strings the error (and its wrapped body) carries. */
function extractCodes(err: any): string[] {
  const out: string[] = [];
  const seen = new Set<any>();
  const visit = (e: any, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 4 || seen.has(e)) return;
    seen.add(e);
    // NB: `status` can be a string enum (Google RESOURCE_EXHAUSTED).
    for (const v of [e.code, e.type, e.status, e.errorCode, e.__type, e.error?.code, e.error?.type,
                     e.error?.status, e.error?.error?.type, e.error?.error?.code, e.body?.error?.code,
                     e.body?.error?.type]) {
      if (typeof v === 'string') out.push(norm(v));
    }
    visit(e.error, depth + 1);
    visit(e.cause, depth + 1);
  };
  visit(err, 0);
  return out;
}

/**
 * Classify one thrown provider/executor error into a failure kind + status.
 * `cancelled` is the executor's own record that the caller asked to stop.
 */
export function classifyError(err: any, opts: { cancelled?: boolean } = {}): { kind: ExecutorFailureKind; status?: number } {
  const status = extractStatus(err);

  if (opts.cancelled) return { kind: 'aborted', status };

  // Typed stream abort minted by streamWithRetry from the guard's own reason.
  if (err instanceof StreamAbortError) {
    return { kind: err.reason === 'external' ? 'aborted' : 'timeout', status };
  }

  const name = className(err);
  const codes = extractCodes(err);
  const has = (set: Set<string>) => codes.some(c => set.has(c));

  // Quota first: a 429 is quota whatever else the body says.
  if (status === 429 || QUOTA_CLASSES.has(name) || has(QUOTA_CODES)) return { kind: 'quota', status };

  if (ABORT_CLASSES.has(name)) return { kind: 'aborted', status };
  if (status === 408 || TIMEOUT_CLASSES.has(name) || TIMEOUT_CODES.has(err?.code)) return { kind: 'timeout', status };

  if (status === 501 || status === 405 || status === 415 || has(UNSUPPORTED_CODES)) return { kind: 'unsupported', status };

  if (status !== undefined) {
    if (status >= 500) return { kind: 'provider_error', status };
    if (status >= 400) return { kind: 'bad_request', status };
  }
  if (SERVER_CLASSES.has(name) || NETWORK_CLASSES.has(name) || NETWORK_CODES.has(err?.code)) {
    return { kind: 'provider_error', status };
  }
  return { kind: 'unknown', status };
}

/** Build one fallback-trail entry from a failed member. */
export function trailEntry(member: { provider?: string; model?: string }, err: any, opts: { cancelled?: boolean } = {}): FallbackTrailEntry {
  const { kind, status } = classifyError(err, opts);
  return { provider: member.provider, model: member.model, kind, status };
}

/**
 * Build the `failure` object for a failed execute() result. `trail` is the
 * per-member trail (last entry = the member whose error is being reported);
 * when absent (error thrown outside model invocation) provider/model come from
 * `fallback`.
 */
export function buildFailure(
  err: any,
  fallback: { provider?: string; model?: string },
  opts: { cancelled?: boolean } = {}
): ExecutorFailure {
  const trail: FallbackTrailEntry[] = Array.isArray(err?.failureTrail) ? err.failureTrail : [];
  const last = trail.length ? trail[trail.length - 1] : undefined;
  const { kind, status } = classifyError(err, opts);
  return {
    kind,
    status,
    provider: last?.provider ?? fallback.provider,
    model: last?.model ?? fallback.model,
    fallbackTrail: trail,
  };
}

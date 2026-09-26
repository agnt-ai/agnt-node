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
 *
 * DELIBERATE DECISIONS (also in README):
 *  - `kind` is NOT a retry instruction. Read `retryable` for that: 529/5xx and a
 *    transient 429 are retryable; `insufficient_quota` / `exceeded_current_quota_error`
 *    are `quota` but retryable:false (permanent until billing changes); 401/403 (`auth`)
 *    and other 4xx are not retryable. `retryable` is undefined for `unknown`.
 *  - 401/403 (and AuthenticationError/PermissionDeniedError/AccessDenied codes) are
 *    `auth`, not `bad_request`: a revoked key is an operator problem.
 *  - 402 with no quota code is `bad_request`; 402 carrying a quota code is `quota`.
 *  - The SDK deliberately does NOT match message text, so a transient failure that a
 *    provider reports only in prose (e.g. Azure "no deployments ready": HTTP 400, no
 *    code) is `bad_request`. A consumer that must catch such cases has to do its own
 *    text match; it will not be found here.
 *  - Node fetch failures: the top-level TypeError('fetch failed') carries the Node code
 *    on `.cause`; codes are read through the cause chain. UND_ERR_SOCKET and the
 *    ECONNRESET/ECONNREFUSED/ENOTFOUND/EAI_AGAIN family are `provider_error`; TLS/certificate errors
 *    (ERR_TLS_*, CERT_*, UNABLE_TO_*) are left `unknown`.
 *  - Only errors that came through invokeWithFallback (they carry `failureTrail`) are
 *    classified by type. Anything else (a tool handler's rethrown error, a variable
 *    validation error) is `unknown` (`aborted` if the caller cancelled), because a
 *    tool error's `.status` says nothing about the LLM provider.
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

/** Quota codes that are permanent until billing/plan changes — quota, but NOT retryable. */
const PERMANENT_QUOTA_CODES = new Set(['insufficientquota', 'exceededcurrentquotaerror']);

/** Error classes / codes for authn/authz failures (revoked or wrong key). */
const AUTH_CLASSES = new Set(['AccessDeniedException', 'AuthenticationError', 'PermissionDeniedError', 'UnauthorizedError']);
const AUTH_CODES = new Set([
  'invalidapikey', 'authenticationerror', 'permissionerror', 'accessdenied', 'accessdeniedexception',
  'unauthorizedexception', 'unauthorized', 'permissiondenied', 'invalidauthentication', 'incorrectapikey',
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
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET']);

const TIMEOUT_CLASSES = new Set(['APIConnectionTimeoutError', 'TimeoutError', 'RequestTimeoutError']);
const ABORT_CLASSES = new Set(['AbortError', 'APIUserAbortError', 'GoogleGenerativeAIAbortError']);
const NETWORK_CLASSES = new Set(['APIConnectionError', 'FetchError']);
const SERVER_CLASSES = new Set(['InternalServerError', 'OverloadedError', 'ServiceUnavailableException']);

/** Every class-ish name an error goes by: constructor.name (minified in some
 *  bundles) AND `.name` (set by DOMException, AWS/smithy, and SDKs that pin it). */
function classNames(e: any): Set<string> {
  const out = new Set<string>();
  const seen = new Set<any>();
  let cur = e;
  for (let d = 0; cur && typeof cur === 'object' && d < 4 && !seen.has(cur); d++) {
    seen.add(cur);
    if (typeof cur.constructor?.name === 'string') out.add(cur.constructor.name);
    if (typeof cur.name === 'string') out.add(cur.name);
    cur = cur.cause;
  }
  return out;
}

/** Node error codes (raw, e.g. ETIMEDOUT) from the error and its cause chain —
 *  Node's `fetch failed` TypeError carries the code on `.cause`. */
function nodeCodes(e: any): string[] {
  const out: string[] = [];
  const seen = new Set<any>();
  let cur = e;
  for (let d = 0; cur && typeof cur === 'object' && d < 4 && !seen.has(cur); d++) {
    seen.add(cur);
    if (typeof cur.code === 'string') out.push(cur.code);
    cur = cur.cause;
  }
  return out;
}

/** A StreamAbortError anywhere in the cause chain (or the error itself). */
function findStreamAbort(e: any): StreamAbortError | undefined {
  const seen = new Set<any>();
  let cur = e;
  for (let d = 0; cur && typeof cur === 'object' && d < 4 && !seen.has(cur); d++) {
    if (cur instanceof StreamAbortError) return cur;
    seen.add(cur);
    cur = cur.cause;
  }
  return undefined;
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
export function classifyError(
  err: any,
  opts: { cancelled?: boolean } = {}
): { kind: ExecutorFailureKind; status?: number; retryable?: boolean } {
  const status = extractStatus(err);

  if (opts.cancelled) return { kind: 'aborted', status, retryable: false };

  // Typed stream abort minted by streamWithRetry from the guard's own reason
  // (also when it is wrapped as a cause by an outer layer).
  const sa = findStreamAbort(err);
  if (sa) {
    return sa.reason === 'external'
      ? { kind: 'aborted', status, retryable: false }
      : { kind: 'timeout', status, retryable: true };
  }

  const names = classNames(err);
  const anyName = (set: Set<string>) => [...names].some(n => set.has(n));
  const codes = extractCodes(err);
  const has = (set: Set<string>) => codes.some(c => set.has(c));
  const nCodes = nodeCodes(err);
  const anyNodeCode = (set: Set<string>) => nCodes.some(c => set.has(c));

  // Quota first (before timeout): a 429 is quota whatever else the body says,
  // even when it also carries a 408/timeout-class signal.
  if (status === 429 || anyName(QUOTA_CLASSES) || has(QUOTA_CODES)) {
    return { kind: 'quota', status, retryable: !has(PERMANENT_QUOTA_CODES) };
  }

  if (anyName(ABORT_CLASSES)) return { kind: 'aborted', status, retryable: false };
  if (status === 408 || anyName(TIMEOUT_CLASSES) || anyNodeCode(TIMEOUT_CODES)) {
    return { kind: 'timeout', status, retryable: true };
  }

  if (status === 501 || status === 405 || status === 415 || has(UNSUPPORTED_CODES)) {
    return { kind: 'unsupported', status, retryable: false };
  }

  if (status === 401 || status === 403 || anyName(AUTH_CLASSES) || has(AUTH_CODES)) {
    return { kind: 'auth', status, retryable: false };
  }

  if (status !== undefined) {
    if (status >= 500) return { kind: 'provider_error', status, retryable: true };
    if (status >= 400) return { kind: 'bad_request', status, retryable: false };
  }
  if (anyName(SERVER_CLASSES) || anyName(NETWORK_CLASSES) || anyNodeCode(NETWORK_CODES)) {
    return { kind: 'provider_error', status, retryable: true };
  }
  return { kind: 'unknown', status };
}

/** Build one fallback-trail entry from a failed member. */
export function trailEntry(member: { provider?: string; model?: string }, err: any, opts: { cancelled?: boolean } = {}): FallbackTrailEntry {
  const { kind, status } = classifyError(err, opts);
  return { provider: member.provider, model: member.model, kind, status };
}

/**
 * Build the `failure` object for a failed execute() result.
 *
 * Type-based classification applies ONLY to errors that came through
 * invokeWithFallback (they carry `failureTrail`). Any other error (e.g. a tool
 * handler's rethrown error, whose `.status` is unrelated to the LLM provider)
 * is `unknown` — or `aborted` if the caller cancelled.
 */
export function buildFailure(
  err: any,
  fallback: { provider?: string; model?: string },
  opts: { cancelled?: boolean } = {}
): ExecutorFailure {
  const viaChain = Array.isArray(err?.failureTrail);
  const trail: FallbackTrailEntry[] = viaChain ? err.failureTrail : [];
  const member = err?.failureMember ?? (trail.length ? trail[trail.length - 1] : undefined);
  const c = viaChain
    ? classifyError(err, opts)
    : { kind: (opts.cancelled ? 'aborted' : 'unknown') as ExecutorFailureKind, status: undefined, retryable: opts.cancelled ? false : undefined };
  const out: ExecutorFailure = {
    kind: c.kind,
    status: c.status,
    provider: member?.provider ?? fallback.provider,
    model: member?.model ?? fallback.model,
    fallbackTrail: trail,
  };
  if (c.retryable !== undefined) out.retryable = c.retryable;
  return out;
}

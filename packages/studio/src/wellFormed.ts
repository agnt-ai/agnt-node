/**
 * Well-form UTF-16 strings so a payload can be safely JSON-serialized for a
 * provider HTTP request.
 *
 * An unpaired surrogate — a high surrogate (\uD800–\uDBFF) with no following low
 * surrogate, or a low surrogate (\uDC00–\uDFFF) with no preceding high one — is
 * not valid JSON text. Anthropic (and every strict JSON encoder) rejects such a
 * request body with `400 invalid_request_error: "The request body is not valid
 * JSON: no low surrogate in string"`. Because a 400 is non-retryable, it defeats
 * model fallback, survives into panic-recovery, and re-poisons any retry task
 * that rebuilds the same context — one bad code unit takes down the whole run.
 *
 * These halves creep in when upstream code truncates a string mid-emoji with
 * `.slice(0, n)` / a byte cap, leaving a dangling surrogate. Rather than chase
 * every truncation site, we neutralize the result once at the dispatch boundary
 * by replacing each lone surrogate with U+FFFD (the Unicode replacement char).
 * Valid surrogate PAIRS (real emoji, astral chars) are left untouched.
 *
 * The runtime is Node 22, which has String.prototype.toWellFormed(), but the
 * package targets ES2022 (no lib typing for it) and declares engines >=18, so we
 * do the replacement with a portable regex instead.
 */

// A lone high surrogate (not followed by a low), OR a lone low surrogate (not
// preceded by a high). Valid pairs match neither branch.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Cheap presence test — the overwhelming majority of strings contain no
// surrogate code unit at all, so we skip the replace + allocation entirely.
const ANY_SURROGATE = /[\uD800-\uDFFF]/;

/** Replace unpaired surrogates in a single string with U+FFFD. */
export function wellFormString(s: string): string {
  if (!ANY_SURROGATE.test(s)) return s;
  return s.replace(LONE_SURROGATE, '�');
}

/**
 * Recursively well-form every string in a value (strings, arrays, plain
 * objects). Copy-on-write: returns the SAME reference when nothing changed, so a
 * clean payload (the common case) incurs no cloning — only the scan.
 */
export function deepWellForm<T>(value: T): T {
  if (typeof value === 'string') {
    return wellFormString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const w = deepWellForm(v);
      if (w !== v) changed = true;
      return w;
    });
    return (changed ? out : value) as unknown as T;
  }
  // Plain objects only — leave class instances / null / functions as-is.
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      const w = deepWellForm(v);
      if (w !== v) changed = true;
      out[key] = w;
    }
    return (changed ? out : value) as unknown as T;
  }
  return value;
}

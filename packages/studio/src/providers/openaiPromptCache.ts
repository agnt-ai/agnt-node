/**
 * Explicit prompt-cache breakpoints for the OpenAI GPT-5.6-and-later families (OpenAI and Azure OpenAI, Responses API).
 *
 * WHY (prod 2026-10-13, Azure Foundry gpt-6.1-sol, task 6ace4384db4c4debc17577a6): on these families caching is
 * BREAKPOINT based. A cache entry is only written and read at a breakpoint, never at an arbitrary common prefix
 * (https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching). With no explicit breakpoints the service
 * runs in `implicit` mode and places one breakpoint on the LATEST MESSAGE. In an agent loop the conversation after
 * the opening is function_call / function_call_output items (not messages), and the latest message is the per-turn
 * note the caller appends last (a clock, live state). So every turn paid a cache WRITE for a prefix ending in a note
 * that never appears again, and the only prefix any turn could read back was the last stable opening message: a run
 * read the same 36,036 tokens on all 32 turns while its input grew to 175K.
 *
 * What this places (request-wide `prompt_cache_options.mode: 'explicit'`, so only these breakpoints read or write):
 *   1. STATIC PREFIX: the end of the leading system message(s). A system message sent as parts with a `cacheBoundary`
 *      part (systemContent.ts) gets it on that part, so the stable part is shared across runs and the per-run part
 *      after it is not; a string system message gets it on the whole message.
 *   2. CONVERSATION TAIL: the last STABLE item of the request: the newest item before the trailing messages the caller
 *      flagged `releaseAfterRead` (the per-turn notes; the same flag keeps them out of Anthropic's cached prefix). A
 *      function_call_output carries it as an `input_text` array (the documented array form of
 *      `function_call_output.output`) with the breakpoint on the last block. In this mode every non-blank
 *      function_call_output and string input message goes as that array form, marked or not, so dropping or adding
 *      a marker never changes an item's other bytes.
 *   3. EARLIER TAILS: the same position before every earlier assistant turn, i.e. exactly where an earlier request of
 *      this conversation put its tail breakpoint. A request only READS a cache entry at a breakpoint it carries
 *      itself, so the previous turn's tail has to be marked again for this turn to read it. Every earlier tail is
 *      marked, up to MAX_BREAKPOINTS in all: past that the oldest tails lose their marker (only the marker), which
 *      keeps the static system breakpoint inside the 50 the service reads.
 *
 * Write slots: the service writes at most four breakpoints per request, the latest four; earlier-turn breakpoints are
 * read-only and reads consider the latest 50. Here only the tail is new on a turn that follows an assistant turn (the
 * static prefix too on the first request), so the tail write is never crowded out, and the turn-over-turn read (the
 * newest earlier tail) is always among the latest 50.
 *
 * Why explicit and not implicit: implicit adds its own breakpoint on the latest message, which is the per-turn note:
 * one billed write per turn that is never read, using one of the four write slots. Explicit mode with the breakpoints
 * above writes only prefixes a later request reads.
 *
 * `disableCache` (one-shot callers): only the static prefix breakpoint, which other calls with the same system part
 * read; nothing request-specific is written.
 *
 * Models before GPT-5.6 reject both parameters with a 400 and are never given them. A Provisioned (PTU-M) Azure
 * deployment does not support breakpoints either: a 400 on a request carrying them is retried once without them,
 * and when that retry succeeds they stay off for that provider + endpoint + model for BREAKPOINT_REJECTION_TTL_MS
 * (logged at warn). A request left with no breakpoint at all (an empty system message under disableCache) is sent
 * with no prompt_cache_options, i.e. implicit, never explicit with nothing to read or write.
 */
import type { Message } from '../types.js';
import { SYSTEM_PART_SEPARATOR } from './systemContent.js';

/** Exported by the package so a caller can tell whether this version places OpenAI cache breakpoints. */
export const PROMPT_CACHE_BREAKPOINT_SUPPORT = 1;

/** The GPT-5.6 and later families (gpt-5.6 … gpt-5.x, gpt-6 … gpt-9 with any point release and suffix). */
const BREAKPOINT_FAMILY = /^gpt-(?:5\.(?:[6-9]|\d{2,})|[6-9](?:\.\d+)?)(?:-|$)/i;

export function supportsPromptCacheBreakpoints(model: string | undefined | null): boolean {
  return BREAKPOINT_FAMILY.test(String(model ?? ''));
}

const BREAKPOINT = { mode: 'explicit' as const };
const INPUT_ROLES = new Set(['system', 'developer', 'user']);

/**
 * At most this many breakpoints in a request, the static system one included. The service reads at the latest 50
 * only; keeping under that keeps the static system breakpoint (the oldest) readable in a long run. The oldest earlier
 * tails are the ones left unmarked: a turn reads the newest one.
 */
export const MAX_BREAKPOINTS = 48;

/** How long a 400 that went away without breakpoints keeps them off for that provider + endpoint + model. */
export const BREAKPOINT_REJECTION_TTL_MS = 15 * 60 * 1000;

const blank = (text: unknown): boolean => typeof text !== 'string' || text.trim() === '';

/** A content block that can carry a breakpoint: non-blank input_text, or an input_image / input_file with a source. */
function carrierBlock(b: any): boolean {
  if (b?.type === 'input_text') return !blank(b.text);
  if (b?.type === 'input_image') return Boolean(b.image_url || b.file_id);
  if (b?.type === 'input_file') return Boolean(b.file_data || b.file_id || b.file_url);
  return false;
}

// provider + endpoint + model -> when breakpoints may be tried again.
const rejected = new Map<string, number>();
const rejectionKey = (provider: string, model: string, endpoint = '') => `${provider}\u0000${endpoint}\u0000${model}`;

export function breakpointsRejected(provider: string, model: string, endpoint?: string, now = Date.now()): boolean {
  const key = rejectionKey(provider, model, endpoint);
  const until = rejected.get(key);
  if (until === undefined) return false;
  if (now < until) return true;
  rejected.delete(key);
  return false;
}
/** Breakpoints off for BREAKPOINT_REJECTION_TTL_MS for this provider + endpoint + model, logged at warn. */
export function markBreakpointsRejected(provider: string, model: string, endpoint?: string, now = Date.now()): void {
  rejected.set(rejectionKey(provider, model, endpoint), now + BREAKPOINT_REJECTION_TTL_MS);
  let host = '';
  try { host = endpoint ? new URL(endpoint).host : ''; } catch { host = ''; }
  console.warn(`[promptCacheBreakpoints] provider=${provider} model=${model}${host ? ` endpoint=${host}` : ''}: a request with cache breakpoints got a 400 that went away without them; breakpoints off for ${BREAKPOINT_REJECTION_TTL_MS / 60000} min (implicit caching meanwhile)`);
}
/** Test seam. */
export function resetBreakpointRejections(): void { rejected.clear(); }

/** A 400 (typed status) on a request that carried breakpoints. Whether the breakpoints caused it is decided by
 *  retrying once without them: only a retry that then succeeds turns them off (markBreakpointsRejected). Not judged
 *  from the message text, which may name the parameter, the array `output` form, or neither. */
export function isBreakpointRejection(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return status === 400;
}

/** Whether a Responses request for this model should carry breakpoints (family, kill switch, earlier rejection). */
export function breakpointsWanted(provider: string, model: string, metadata: Record<string, any> | undefined, endpoint?: string): boolean {
  if (!supportsPromptCacheBreakpoints(model)) return false;
  if (metadata?.prompt_cache_breakpoints === false) return false;
  return !breakpointsRejected(provider, model, endpoint);
}

/** Whether an input item can carry a breakpoint: a non-blank function_call_output, or a non-blank input message. */
function canCarry(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'function_call_output') {
    if (typeof item.output === 'string') return !blank(item.output);
    return Array.isArray(item.output) && item.output.some(carrierBlock);
  }
  if ((item.type === undefined || item.type === 'message') && INPUT_ROLES.has(item.role)) {
    if (typeof item.content === 'string') return !blank(item.content);
    return Array.isArray(item.content) && item.content.some(carrierBlock);
  }
  return false;
}

/** The blocks with a breakpoint on the last block that can carry one. */
function markBlocks(blocks: any[]): any[] {
  let at = -1;
  for (let i = blocks.length - 1; i >= 0; i--) if (carrierBlock(blocks[i])) { at = i; break; }
  if (at < 0) return blocks;
  return blocks.map((b, i) => (i === at ? { ...b, prompt_cache_breakpoint: BREAKPOINT } : b));
}

/**
 * The item's wire form in breakpoint mode: a non-blank string function_call_output or input-message content becomes
 * one input_text block, whether or not it carries a marker now. Its bytes then depend only on its content, so adding
 * or dropping a marker (a new tail, the MAX_BREAKPOINTS cap) never changes anything but the marker. A blank string
 * stays a string on every turn (no empty block is ever made, and it never carries a marker).
 */
function arrayForm(item: any): any {
  if (!item || typeof item !== 'object') return item;
  if (item.type === 'function_call_output') {
    return typeof item.output === 'string' && !blank(item.output) ? { ...item, output: [{ type: 'input_text', text: item.output }] } : item;
  }
  if ((item.type === undefined || item.type === 'message') && INPUT_ROLES.has(item.role) && typeof item.content === 'string' && !blank(item.content)) {
    return { ...item, content: [{ type: 'input_text', text: item.content }] };
  }
  return item;
}

/** A copy of the item (already in arrayForm) with a breakpoint on its last carrying block. */
function mark(item: any): any {
  if (item.type === 'function_call_output') return { ...item, output: markBlocks(item.output) };
  return { ...item, content: markBlocks(item.content) };
}

function isMarked(item: any): boolean {
  const blocks = item?.type === 'function_call_output' ? item.output : item?.content;
  return Array.isArray(blocks) && blocks.some((b: any) => b?.prompt_cache_breakpoint);
}

/**
 * A system message's Responses item with a breakpoint at its static boundary: one input_text block per non-empty part,
 * every later part starting with the separator so the model reads exactly the joined text, the breakpoint on the part
 * marked `cacheBoundary` (on the last non-blank part when none is marked, on the whole message when it is a string).
 * An empty or whitespace-only system message gets no breakpoint and goes out as its joined text.
 */
export function systemItemWithBreakpoint(message: Message): any {
  if (!Array.isArray(message.content)) {
    const text = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    if (blank(text)) return { role: message.role, content: text };
    return { role: message.role, content: [{ type: 'input_text', text, prompt_cache_breakpoint: BREAKPOINT }] };
  }
  const parts = message.content
    .map((p: any) => ({ text: typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '', boundary: p?.cacheBoundary === true }))
    .filter(p => p.text);
  let at = -1;
  for (let i = 0; i < parts.length; i++) if (parts[i].boundary && !blank(parts[i].text)) at = i;
  if (at < 0) for (let i = parts.length - 1; i >= 0; i--) if (!blank(parts[i].text)) { at = i; break; }
  if (at < 0) return { role: message.role, content: parts.map(p => p.text).join(SYSTEM_PART_SEPARATOR) };
  return {
    role: message.role,
    content: parts.map((p, i) => ({
      type: 'input_text',
      text: i === 0 ? p.text : SYSTEM_PART_SEPARATOR + p.text,
      ...(i === at ? { prompt_cache_breakpoint: BREAKPOINT } : {}),
    })),
  };
}

/**
 * Place the conversation breakpoints. `groups[i]` holds the input items canonical message `messages[i]` produced, in
 * order (the leading system message may already carry its static breakpoint). Returns the flat input. The newest tails
 * are kept when there are more than MAX_BREAKPOINTS in all.
 */
export function placeConversationBreakpoints(messages: Message[], groups: any[][], { cacheOn }: { cacheOn: boolean }): any[] {
  if (!cacheOn) return groups.flat();
  const out = groups.map(g => g.map(arrayForm));
  // The last carrying item at or before message `from`, not before message `floor`, as [message, item].
  const lastCarrier = (from: number, floor: number): [number, number] | null => {
    for (let i = from; i >= floor; i--) {
      if (messages[i]?.role === 'assistant') return null;
      const g = out[i];
      for (let j = g.length - 1; j >= 0; j--) if (canCarry(g[j])) return [i, j];
    }
    return null;
  };
  const tails: Array<[number, number]> = [];
  const add = (at: [number, number] | null) => {
    if (!at || isMarked(out[at[0]][at[1]])) return;
    if (!tails.some(([i, j]) => i === at[0] && j === at[1])) tails.push(at);
  };
  // Earlier tails: before each assistant turn, the newest stable (not releaseAfterRead) item of the segment before it.
  let segmentStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'assistant') continue;
    if (i > 0 && messages[i - 1]?.role !== 'assistant') {
      let k = i - 1;
      while (k >= segmentStart && messages[k]?.releaseAfterRead) k--;
      if (k >= segmentStart) add(lastCarrier(k, segmentStart));
    }
    segmentStart = i + 1;
  }
  // This request's tail: the newest item before the trailing releaseAfterRead messages.
  let k = messages.length - 1;
  while (k >= 0 && messages[k]?.releaseAfterRead) k--;
  if (k >= segmentStart) add(lastCarrier(k, segmentStart));
  const already = out.reduce((n, g) => n + g.filter(isMarked).length, 0);
  for (const [i, j] of tails.slice(-Math.max(0, MAX_BREAKPOINTS - already))) out[i][j] = mark(out[i][j]);
  return out.flat();
}

/** Breakpoints in an input array (a test and diagnostics helper). */
export function breakpointIndexes(input: any[]): number[] {
  return input.map((item, i) => (isMarked(item) ? i : -1)).filter(i => i >= 0);
}

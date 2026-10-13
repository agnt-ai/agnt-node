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
 *      function_call_output carries it by sending its output as an `input_text` array (the documented array form of
 *      `function_call_output.output`) with the breakpoint on the last block.
 *   3. EARLIER TAILS: the same position before every earlier assistant turn, i.e. exactly where an earlier request of
 *      this conversation put its tail breakpoint. A request only READS a cache entry at a breakpoint it carries
 *      itself, so the previous turn's tail has to be marked again for this turn to read it. Marking every earlier
 *      tail (not only the newest) keeps each item's bytes identical from the request that first sent it onward, so
 *      the result does not depend on whether the service hashes the marker with the content.
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
 * deployment does not support breakpoints either; a 400 that names these parameters turns them off for that
 * provider + model in this process and the request is retried once without them (see the providers).
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
const CARRIER_BLOCKS = new Set(['input_text', 'input_image', 'input_file']);
const INPUT_ROLES = new Set(['system', 'developer', 'user']);

// Provider + model pairs a 400 showed cannot take breakpoints (a PTU-M deployment, an API that predates them).
const rejected = new Set<string>();
const rejectionKey = (provider: string, model: string, endpoint = '') => `${provider}\u0000${endpoint}\u0000${model}`;

export function breakpointsRejected(provider: string, model: string, endpoint?: string): boolean {
  return rejected.has(rejectionKey(provider, model, endpoint));
}
export function markBreakpointsRejected(provider: string, model: string, endpoint?: string): void {
  rejected.add(rejectionKey(provider, model, endpoint));
}
/** Test seam. */
export function resetBreakpointRejections(): void { rejected.clear(); }

/** A 400 whose message names the breakpoint parameters (typed status first; the text only picks which 400). */
export function isBreakpointRejection(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status !== 400) return false;
  const text = `${err?.message ?? ''} ${err?.error?.message ?? ''} ${err?.param ?? err?.error?.param ?? ''}`;
  return /prompt_cache_(?:breakpoint|options)/i.test(text);
}

/** Whether a Responses request for this model should carry breakpoints (family, kill switch, earlier rejection). */
export function breakpointsWanted(provider: string, model: string, metadata: Record<string, any> | undefined, endpoint?: string): boolean {
  if (!supportsPromptCacheBreakpoints(model)) return false;
  if (metadata?.prompt_cache_breakpoints === false) return false;
  return !breakpointsRejected(provider, model, endpoint);
}

/** Whether an input item can carry a breakpoint: a function_call_output, or an input message (system/developer/user). */
function canCarry(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'function_call_output') {
    if (typeof item.output === 'string') return true;
    return Array.isArray(item.output) && item.output.some((b: any) => CARRIER_BLOCKS.has(b?.type));
  }
  if ((item.type === undefined || item.type === 'message') && INPUT_ROLES.has(item.role)) {
    if (typeof item.content === 'string') return true;
    return Array.isArray(item.content) && item.content.some((b: any) => CARRIER_BLOCKS.has(b?.type));
  }
  return false;
}

/** The blocks with a breakpoint on the last block that can carry one. */
function markBlocks(blocks: any[]): any[] {
  let at = -1;
  for (let i = blocks.length - 1; i >= 0; i--) if (CARRIER_BLOCKS.has(blocks[i]?.type)) { at = i; break; }
  if (at < 0) return blocks;
  return blocks.map((b, i) => (i === at ? { ...b, prompt_cache_breakpoint: BREAKPOINT } : b));
}

/** A copy of the item with a breakpoint on its last carrying block (string content becomes one input_text block). */
function mark(item: any): any {
  if (item.type === 'function_call_output') {
    const output = typeof item.output === 'string' ? [{ type: 'input_text', text: item.output }] : item.output;
    return { ...item, output: markBlocks(output) };
  }
  const content = typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content;
  return { ...item, content: markBlocks(content) };
}

function isMarked(item: any): boolean {
  const blocks = item?.type === 'function_call_output' ? item.output : item?.content;
  return Array.isArray(blocks) && blocks.some((b: any) => b?.prompt_cache_breakpoint);
}

/**
 * A system message's Responses item with a breakpoint at its static boundary: one input_text block per part, every
 * later part starting with the separator so the model reads exactly the joined text, the breakpoint on the part
 * marked `cacheBoundary` (on the last part when none is marked, on the whole message when it is a string).
 */
export function systemItemWithBreakpoint(message: Message): any {
  if (!Array.isArray(message.content)) {
    const text = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    return { role: message.role, content: [{ type: 'input_text', text, prompt_cache_breakpoint: BREAKPOINT }] };
  }
  const parts = message.content
    .map((p: any) => ({ text: typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '', boundary: p?.cacheBoundary === true }))
    .filter(p => p.text);
  let at = -1;
  for (let i = 0; i < parts.length; i++) if (parts[i].boundary) at = i;
  if (at < 0) at = parts.length - 1;
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
 * order (the leading system messages already carry their static breakpoint). Returns the flat input.
 */
export function placeConversationBreakpoints(messages: Message[], groups: any[][], { cacheOn }: { cacheOn: boolean }): any[] {
  if (cacheOn) {
    const out = groups.map(g => g.slice());
    // The last carrying item at or before message `from`, not before message `floor`; marks it in place.
    const markLastCarrier = (from: number, floor: number): void => {
      for (let i = from; i >= floor; i--) {
        if (messages[i]?.role === 'assistant') return;
        const g = out[i];
        for (let j = g.length - 1; j >= 0; j--) {
          if (canCarry(g[j])) { if (!isMarked(g[j])) g[j] = mark(g[j]); return; }
        }
      }
    };
    // Earlier tails: before each assistant turn, the newest stable (not releaseAfterRead) item of the segment before it.
    let segmentStart = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role !== 'assistant') continue;
      if (i > 0 && messages[i - 1]?.role !== 'assistant') {
        let k = i - 1;
        while (k >= segmentStart && messages[k]?.releaseAfterRead) k--;
        if (k >= segmentStart) markLastCarrier(k, segmentStart);
      }
      segmentStart = i + 1;
    }
    // This request's tail: the newest item before the trailing releaseAfterRead messages.
    let k = messages.length - 1;
    while (k >= 0 && messages[k]?.releaseAfterRead) k--;
    if (k >= segmentStart) markLastCarrier(k, segmentStart);
    return out.flat();
  }
  return groups.flat();
}

/** Breakpoints in an input array (a test and diagnostics helper). */
export function breakpointIndexes(input: any[]): number[] {
  return input.map((item, i) => (isMarked(item) ? i : -1)).filter(i => i >= 0);
}

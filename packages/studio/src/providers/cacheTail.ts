/**
 * Where a conversation's cache breakpoints go on providers that cache at explicit marks (Anthropic `cache_control`,
 * Bedrock `cachePoint`). Indexes are into the conversation (the request's messages without system messages).
 *
 * TAIL: the newest message that is not one of the trailing `releaseAfterRead` notes (a clock, live state, re-sent and
 * replaced on every turn). Writing the cache at a note would store a prefix no later request starts with.
 *
 * EARLIER TAIL: the same position as seen by the previous request, i.e. the newest stable message before the last
 * assistant turn. That request wrote its entry exactly there. Anthropic finds an earlier entry from a breakpoint by
 * looking back at most 20 block positions (a run of consecutive tool_use blocks counts as one position, and so does a
 * run of consecutive tool_result blocks), so a turn that appends more than 20 positions (text, thinking and tool runs
 * across several assistant/user exchanges, long notes split into blocks) would otherwise miss the whole conversation
 * and re-write it. A breakpoint on a prefix that is already cached
 * is a read and costs nothing extra; when it is not cached the tokens are written once either way.
 */
import type { Message } from '../types.js';

/** The newest message that is not a trailing `releaseAfterRead` note, or -1. */
export function stableTailIndex(conversation: Message[]): number {
  let k = conversation.length - 1;
  while (k >= 0 && conversation[k]?.releaseAfterRead) k--;
  return k;
}

/** The previous request's tail: the newest stable non-assistant message before the last assistant turn, or -1. */
export function earlierTailIndex(conversation: Message[]): number {
  let a = conversation.length - 1;
  while (a >= 0 && conversation[a]?.role !== 'assistant') a--;
  if (a <= 0) return -1;
  let k = a - 1;
  while (k >= 0 && conversation[k]?.releaseAfterRead) k--;
  if (k < 0 || conversation[k]?.role === 'assistant') return -1;
  return k;
}

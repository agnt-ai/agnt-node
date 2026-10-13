/**
 * Cache buckets from an OpenAI-shaped usage block (OpenAI and Azure OpenAI, Chat Completions and Responses).
 *
 * `cached_tokens` (reads) has always been reported. GPT-5.6 and later families also bill cache WRITES and report them
 * as `cache_write_tokens` beside it (Azure: prompt_tokens_details / input_tokens_details). Both are subsets of the
 * prompt total, so both come out of `input_tokens` to keep the four buckets disjoint; until now writes were left in
 * input and `cache_creation_input_tokens` was hard-coded to 0, so a run could not tell a cache write from a miss.
 */
export interface OpenAICacheDetails { cached_tokens?: number | null; cache_write_tokens?: number | null }

export function openaiCacheBuckets(promptTotal: number, details: OpenAICacheDetails | null | undefined): {
  input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
} {
  const total = Math.max(0, Number(promptTotal) || 0);
  const read = Math.max(0, Number(details?.cached_tokens) || 0);
  const write = Math.min(Math.max(0, total - read), Math.max(0, Number(details?.cache_write_tokens) || 0));
  return { input_tokens: Math.max(0, total - read - write), cache_read_input_tokens: read, cache_creation_input_tokens: write };
}

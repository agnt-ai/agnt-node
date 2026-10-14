/**
 * Prompt caching per provider: one table, so a caller (the agnt backend) never decides caching by model id.
 *
 * Every provider caches a PREFIX: the request must start with exactly the bytes an earlier request sent. What differs
 * is who chooses where an entry is written and read, and how the result is reported:
 *
 *   anthropic        explicit `cache_control` breakpoints, at most 4 per request (tools -> system -> messages order),
 *                    5-minute TTL (1h costs 2x on writes, see below), writes billed 1.25x, reads 0.1x (0.05x Sonnet/Opus
 *                    5.5, 0.025x Fable 5.1). A read looks back at most 20 block positions from each breakpoint for an
 *                    earlier write. Usage: cache_read_input_tokens / cache_creation_input_tokens, disjoint from input.
 *   bedrock (Claude) the same model behind Converse `cachePoint` blocks (tools, system, messages; at most 4).
 *                    Usage: cacheReadInputTokens / cacheWriteInputTokens, disjoint from inputTokens.
 *   bedrock (Nova)   implicit caching; explicit checkpoints only in system/messages and only within the first 20K
 *                    tokens, so none are placed (bedrock.ts). Usage as above.
 *   openai / azure   GPT-5.6 and later: breakpoint based (openaiPromptCache.ts), 30-minute TTL, writes 1.25x.
 *                    Earlier models: automatic prefix caching, no write charge. `prompt_cache_key` routes a lane of
 *                    related requests to the same cache (OpenAI: every model; Azure: GPT-5.6 and later).
 *   google           Gemini 2.5+ implicit caching (automatic, prefix based, min 2,048-4,096 tokens), no write charge.
 *                    Explicit cachedContents is NOT used: it bills storage per hour and gives the same read discount.
 *   openai-compatible automatic prefix caching on every host we route (Together, Fireworks, DeepInfra, DeepSeek,
 *                    Moonshot, xAI, Groq, Mistral); no write charge; cached tokens reported under one of several
 *                    spellings (openaiCompatible.ts). xAI routes by the `x-grok-conv-id` header and Mistral by a
 *                    `prompt_cache_key` body field, so both take the lane key; the others have no affinity control.
 *
 * Model-family rules live here and in the adapters, never in the caller.
 */
import { supportsPromptCacheBreakpoints } from './openaiPromptCache.js';

/** Exported by the package so a caller can tell whether this version has the capability table. */
export const PROMPT_CACHE_CAPABILITIES_SUPPORT = 1;

export type PromptCacheMechanism =
  /** The adapter places explicit breakpoints (Anthropic cache_control, Bedrock cachePoint, GPT-5.6+ breakpoints). */
  | 'explicit'
  /** The provider caches matching prefixes by itself; the adapter only keeps the prefix stable and reads usage. */
  | 'automatic';

export interface PromptCacheCapability {
  mechanism: PromptCacheMechanism;
  /** How a lane key (`metadata.prompt_cache_key`) reaches the provider, or null when the provider has no such control. */
  affinityKey: 'body' | 'header' | null;
  /** Whether the provider bills cache writes at a premium (and reports them). */
  billsWrites: boolean;
}

const AUTOMATIC: PromptCacheCapability = { mechanism: 'automatic', affinityKey: null, billsWrites: false };

/** Bedrock model ids that carry explicit Claude checkpoints (any inference-profile prefix or ARN), minus the Claude
 *  models whose Bedrock prompt caching is unsupported or still Preview (Claude 3 / 3.5 Sonnet incl. v2 / 3.5 Haiku /
 *  Instant / v2); those keep Bedrock's implicit caching. */
const BEDROCK_CLAUDE = /(^|[.:/])anthropic\.claude-/i;
const BEDROCK_CLAUDE_UNCACHED = /anthropic\.claude-(?:3-(?:opus|sonnet|haiku)-|3-5-(?:haiku|sonnet)-|instant|v2)/i;

export function bedrockTakesCachePoints(model: string | undefined | null): boolean {
  const m = String(model ?? '');
  return BEDROCK_CLAUDE.test(m) && !BEDROCK_CLAUDE_UNCACHED.test(m);
}

/** The caching capability of one provider + model. */
export function promptCacheCapability(provider: string | undefined | null, model: string | undefined | null): PromptCacheCapability {
  const p = String(provider ?? '').toLowerCase();
  switch (p) {
    case 'anthropic':
      return { mechanism: 'explicit', affinityKey: null, billsWrites: true };
    case 'bedrock':
      return bedrockTakesCachePoints(model) ? { mechanism: 'explicit', affinityKey: null, billsWrites: true } : AUTOMATIC;
    case 'openai':
      return supportsPromptCacheBreakpoints(model)
        ? { mechanism: 'explicit', affinityKey: 'body', billsWrites: true }
        : { mechanism: 'automatic', affinityKey: 'body', billsWrites: false };
    case 'azurefoundry':
      return supportsPromptCacheBreakpoints(model)
        ? { mechanism: 'explicit', affinityKey: 'body', billsWrites: true }
        : AUTOMATIC;
    case 'xai':
      return { mechanism: 'automatic', affinityKey: 'header', billsWrites: false };
    case 'mistral':
      return { mechanism: 'automatic', affinityKey: 'body', billsWrites: false };
    default:
      return AUTOMATIC;
  }
}

/** Whether a model chain member should be given the lane key (`metadata.prompt_cache_key`). */
export function takesPromptCacheKey(provider: string | undefined | null, model: string | undefined | null): boolean {
  return promptCacheCapability(provider, model).affinityKey !== null;
}

/**
 * Metadata keys about caching that are never request parameters: `prompt_cache_breakpoints: false` turns this SDK's
 * own breakpoints off (the kill switch); `prompt_cache_key` is a wire parameter only where the provider takes one in
 * the body. An adapter that spreads metadata into its request strips these first.
 */
export function withoutCacheControlMetadata(params: Record<string, any>, { keepKey = false }: { keepKey?: boolean } = {}): Record<string, any> {
  const { prompt_cache_breakpoints: _off, prompt_cache_key: key, ...rest } = params;
  return keepKey && key != null ? { ...rest, prompt_cache_key: key } : rest;
}

/** Whether the caller switched this SDK's cache breakpoints off for this model (`metadata.prompt_cache_breakpoints`). */
export function breakpointsSwitchedOff(metadata: Record<string, any> | undefined | null): boolean {
  return metadata?.prompt_cache_breakpoints === false;
}

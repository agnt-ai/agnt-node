/**
 * DeepSeekExecutor — back-compat shim.
 *
 * DeepSeek is an OpenAI-compatible provider and is now served by the shared
 * OpenAICompatibleExecutor (see ./openaiCompatible.ts), which — unlike the old
 * standalone DeepSeek adapter — also captures automatic cache-read tokens from
 * usage cached_tokens and streams responses with an idle timeout. This file
 * remains only so existing direct imports of './providers/deepseek.js' resolve.
 */

export { default, OPENAI_COMPATIBLE_BASE_URLS, OPENAI_COMPATIBLE_PROVIDERS } from './openaiCompatible.js';

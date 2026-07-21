/**
 * AnthropicExecutor - Provider adapter for Anthropic models
 *
 * Uses native @anthropic-ai/sdk (not LangChain)
 */

import Anthropic from '@anthropic-ai/sdk';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { fileToAnthropicDocument } from './fileAttachment.js';
import { streamWithRetry, STREAM_ABSOLUTE_BACKSTOP_MS } from './streaming.js';

/**
 * Claude's "reasoning family" — the current models whose reasoning is driven by
 * adaptive thinking + `output_config.effort`, and which REJECT the legacy
 * sampling knobs (`temperature`/`top_p`/`top_k`) and `budget_tokens` with a 400.
 * On these models thinking is OFF unless `thinking: {type:'adaptive'}` is sent
 * explicitly (Opus 4.7/4.8), so effort has no effect without it. Older Claude
 * models (Sonnet 4.5, Haiku 4.5, Opus 4.6/4.5) are intentionally excluded — they
 * use `budget_tokens`, still accept sampling params, and reject `effort`.
 * Confirmed against the claude-api reference (2026-07-21).
 */
const ANTHROPIC_REASONING_FAMILY = /^claude-(opus-4-8|opus-4-7|sonnet-5|fable-5|mythos-5)(-|$)/i;

/** Legacy sampling knobs the reasoning family rejects (400) alongside adaptive thinking. */
const ANTHROPIC_REASONING_UNSUPPORTED_PARAMS = ['temperature', 'top_p', 'top_k', 'budget_tokens'];

export default class AnthropicExecutor extends BaseExecutor {
  private client: Anthropic;

  constructor(config: BaseExecutorConfig) {
    super(config);

    // Get Anthropic credentials
    const anthropicCreds = this.credentials.anthropic;
    if (!anthropicCreds) {
      throw new Error('[AnthropicExecutor] credentials.anthropic is required');
    }
    if (!anthropicCreds.apiKey) {
      throw new Error('[AnthropicExecutor] credentials.anthropic.apiKey is required');
    }

    // Initialize Anthropic client
    this.client = new Anthropic({
      apiKey: anthropicCreds.apiKey,
      // Absorb transient overload (529), rate-limit (429), and 5xx/timeout
      // spikes at the SDK layer with exponential backoff before they ever reach
      // the executor's model-fallback path. The SDK default is 2, which a brief
      // capacity blip can exhaust — surfacing as a hard error mid-run.
      // `invoke()` STREAMS the response (see below) and bounds it with an
      // inter-chunk IDLE timeout, so a long-but-progressing turn (a full deck /
      // report) never times out. The client `timeout` here is only the SDK's own
      // total-request cap; we set it to the streaming absolute backstop so the
      // SDK never kills a healthily-streaming response shorter than our own idle
      // guard would. It is not the operative ceiling — the idle timeout is.
      maxRetries: 3,
      timeout: STREAM_ABSOLUTE_BACKSTOP_MS,
      dangerouslyAllowBrowser: anthropicCreds.dangerouslyAllowBrowser
    });

    this.log(`[AnthropicExecutor] Initialized with model: ${this.model}`);
  }

  /**
   * Invoke Anthropic API
   * Returns: { message: { role, content, tool_calls }, usage: { input_tokens, output_tokens } }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    // Extract provider-specific parameters from model config
    const providerParams = this.#extractProviderParams();

    // Extract system messages (Anthropic requires separate system parameter)
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m => m.content).join('\n\n');

    // Build request parameters
    const params: any = {
      model: this.model,
      max_tokens: providerParams.max_tokens || providerParams.maxTokens || 4096,
      messages: this.#formatMessages(messages),
      ...providerParams // Spread all provider-specific params
    };

    // Reasoning: opt-in via the model-strategy's `reasoning_effort` (the console
    // Effort control). When set on a reasoning-family model, turn on adaptive
    // thinking + `output_config.effort` and drop the params that 400 alongside
    // it. When unset, this is a no-op — existing behavior is unchanged.
    this.#applyReasoningParams(params);
    // ── Prompt caching: ALWAYS explicit block-level breakpoints ──────────────
    // A top-level `cache_control` is NOT honored by Anthropic (cache_control
    // lives on content blocks), which left the big stable prefix re-written
    // every turn with cache_read=0. We place real breakpoints instead, in
    // Anthropic's prefix order (tools → system → messages):
    //   1. tools        — stable across the run → a READ after turn 1
    //   2. system        — the big stable prefix → a READ after turn 1
    //   3. message-tail  — the latest message that is NOT a trailing
    //                      `release_after_read` result. Kept messages READ
    //                      turn-over-turn; an already-cached prefix is a cache
    //                      HIT (no re-write — only genuinely new tokens write).
    //
    // `release_after_read` (the agent's "I'll read this once and drop it"
    // warning): trailing flagged results stay in the UNCACHED suffix, so we
    // never pay the write surcharge on content that's about to leave. A
    // `release` that stubs an EARLIER message only invalidates from that point —
    // tools, system, and the prefix before it still read.
    //
    // One-shot callers (QA, ignore/duplicate checks, etc.) pass disableCache:
    // true — no follow-up turn, so any write surcharge is pure waste.
    const cacheOn = !options.disableCache;
    const EPHEMERAL = { type: 'ephemeral' as const };

    // System as a cached block.
    if (systemContent) {
      params.system = cacheOn
        ? [{ type: 'text', text: systemContent, cache_control: EPHEMERAL }]
        : systemContent;
    }

    // Tools — cache the last def so the whole (stable) tools array is one
    // cached segment.
    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map((t: any) => this.#formatTool(t));
      if (cacheOn && params.tools.length > 0) {
        const last = params.tools[params.tools.length - 1];
        params.tools[params.tools.length - 1] = { ...last, cache_control: EPHEMERAL };
      }
    }

    // Message-tail breakpoint at the last NON-(trailing-read-once) message.
    // #formatMessages drops system messages and is 1:1 (same order) with the
    // non-system source messages, so the formatted array aligns with them.
    if (cacheOn && params.messages.length > 0) {
      const nonSystem = messages.filter(m => m.role !== 'system');
      let k = nonSystem.length - 1;
      while (k >= 0 && (nonSystem[k] as Message).releaseAfterRead) k--;
      if (k >= 0 && params.messages[k]) {
        this.#attachCacheControl(params.messages[k]);
      }
    }

    // Add tool_choice if specified
    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatToolChoice(options.tool_choice);
    }

    // Call Anthropic API — STREAMED. `messages.stream()` accumulates text and
    // tool_use (partial_json) deltas internally and `finalMessage()` returns the
    // exact same assembled Message shape `messages.create()` would, so the usage
    // + extraction below is unchanged. We bump the idle timer on every stream
    // event; a healthily-progressing response never trips it. A mid-stream
    // failure (stall or network drop) discards the partial and retries the whole
    // prompt, up to the retry budget.
    this.debug(`[AnthropicExecutor] Final messages payload:\n${JSON.stringify({ system: params.system, messages: params.messages }, null, 2)}`);
    const response = await streamWithRetry(
      async (guard) => {
        const stream = this.client.messages.stream(params, { signal: guard.signal });
        stream.on('streamEvent', () => guard.bump());
        return await stream.finalMessage();
      },
      {
        externalSignal: options.signal,
        isRetryable: (err) => this.isRetryableError(err),
        log: (m) => this.log(m),
      }
    );

    // Format response to match expected structure
    const usageTyped = response.usage as typeof response.usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    // Preserve thinking blocks verbatim so they can be echoed back unchanged on
    // the next same-model turn — Anthropic requires this during tool use with
    // thinking on, or the following request 400s. Kept in `rawParts` (the same
    // channel the Google adapter uses for thoughtSignatures) and undefined when
    // thinking is off, so non-reasoning turns carry nothing.
    const reasoningBlocks = (response.content || []).filter(
      (b: any) => b?.type === 'thinking' || b?.type === 'redacted_thinking'
    );

    return {
      message: {
        role: 'assistant',
        content: this.#extractTextContent(response.content),
        tool_calls: this.#extractToolCalls(response.content),
        ...(reasoningBlocks.length ? { rawParts: reasoningBlocks } : {})
      },
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: usageTyped.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usageTyped.cache_creation_input_tokens ?? 0
      }
    };
  }

  /**
   * Check if message has tool calls
   */
  hasToolCalls(message: Message): boolean {
    return Boolean(message?.tool_calls && message.tool_calls.length > 0);
  }

  /**
   * Format messages for Anthropic API
   * Converts from standard format to Anthropic format
   */
  #formatMessages(messages: Message[]): any[] {
    const formatted: any[] = [];

    for (const msg of messages) {
      // Skip system messages (handled separately in Anthropic)
      if (msg.role === 'system') {
        continue;
      }

      // Handle tool messages
      if (msg.role === 'tool') {
        formatted.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content
            }
          ]
        });
        continue;
      }

      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const content: any[] = [];

        // Thinking blocks first, verbatim (with signature) — Anthropic requires
        // them ahead of tool_use on the same-model turn when thinking is on.
        if (Array.isArray(msg.rawParts) && msg.rawParts.length) {
          content.push(...msg.rawParts);
        }

        // Add text content if present
        if (msg.content) {
          content.push({
            type: 'text',
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }

        // Add tool_use blocks
        for (const toolCall of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args
          });
        }

        formatted.push({
          role: 'assistant',
          content
        });
        continue;
      }

      // Assistant final-answer turn that carried thinking blocks: echo them
      // back verbatim ahead of the text so a same-model continuation doesn't 400.
      if (msg.role === 'assistant' && Array.isArray(msg.rawParts) && msg.rawParts.length) {
        const content: any[] = [...msg.rawParts];
        if (msg.content) {
          content.push({
            type: 'text',
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }
        formatted.push({ role: 'assistant', content });
        continue;
      }

      // Handle user/assistant messages without tool calls
      formatted.push({
        role: msg.role,
        content: typeof msg.content === 'string'
          ? msg.content
          : this.#formatContent(msg.content)
      });
    }

    return formatted;
  }

  /**
   * Attach an ephemeral cache breakpoint to a formatted message's last content
   * block (converting string content to a text block if needed). Used for the
   * RR release_after_read message-prefix breakpoint.
   */
  #attachCacheControl(msg: any): void {
    if (!msg) return;
    if (typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const i = msg.content.length - 1;
      msg.content[i] = { ...msg.content[i], cache_control: { type: 'ephemeral' } };
    }
  }

  /**
   * Format content blocks (for images, etc.)
   */
  #formatContent(content: any): any {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map(item => {
        if (item.type === 'text') {
          return { type: 'text', text: item.text };
        }
        if (item.type === 'image_url') {
          // Extract image data
          const imageUrl = typeof item.image_url === 'string'
            ? item.image_url
            : item.image_url?.url;

          // If it's a data URL, extract base64 and media type
          if (imageUrl && imageUrl.startsWith('data:')) {
            const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const mediaType = match[1];
              const data = match[2];

              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data
                }
              };
            }
          }

          // If it's a URL, Anthropic expects it to be converted to base64
          // This should be handled by ImageCache before getting here
          this.log('[AnthropicExecutor] Warning: Image URL should be converted to base64 before invoking');
          return null;
        }
        if (item.type === 'file') {
          // Cross-provider file block (e.g. PDF) → Anthropic document block.
          const doc = fileToAnthropicDocument(item);
          if (doc) return doc;
          this.log('[AnthropicExecutor] Warning: file block missing base64 data URL — dropping');
          return null;
        }

        return item;
      }).filter(Boolean);
    }

    return content;
  }

  /**
   * Format tool definition for Anthropic
   */
  #formatTool(tool: any): any {
    // Priority order:
    // 1. Studio format: { name, description, parameters, metadata? } - PRIMARY from Studio API
    // 2. Anthropic format: { name, description, input_schema } - for compatibility
    // 3. OpenAI format: { type: "function", function: { name, description, parameters } } - for compatibility

    // Studio format (PRIMARY): { name, description, parameters, metadata? }
    // Check for parameters first since that's what Studio sends
    if (tool.name && tool.parameters && !tool.function && !tool.input_schema) {
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters
      };
    }

    // Anthropic format: { name, description, input_schema }
    if (tool.name && tool.input_schema && !tool.function) {
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.input_schema
      };
    }

    // OpenAI format: { type: "function", function: { name, description, parameters } }
    if (tool.function) {
      return {
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      };
    }

    // Fallback: try to salvage
    return {
      name: tool.name || 'unknown',
      description: tool.description || '',
      input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
    };
  }

  /**
   * Format tool_choice for Anthropic
   */
  #formatToolChoice(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      if (toolChoice === 'required' || toolChoice === 'any') {
        // Allow parallel tool calls — the model can emit several tool_use
        // blocks in one turn (handleToolCalls already iterates and runs them
        // all). `type: 'any'` still forces at least one tool call (progress),
        // so we keep the forced-progress guarantee AND get parallelism.
        // Previously this hardcoded `disable_parallel_tool_use: true`, which
        // was stricter than Anthropic's own default (parallel allowed) for no
        // reason and serialized every agent run one tool per turn.
        return { type: 'any' };
      }
      return { type: 'auto' };
    }

    if (toolChoice.type === 'function' && toolChoice.function?.name) {
      return { type: 'tool', name: toolChoice.function.name };
    }

    return toolChoice;
  }

  /**
   * Extract text content from response
   */
  #extractTextContent(content: any[]): string {
    if (!content || content.length === 0) {
      return '';
    }

    // Find text blocks
    const textBlocks = content.filter(block => block.type === 'text');
    if (textBlocks.length === 0) {
      return '';
    }

    return textBlocks.map(block => block.text).join('\n');
  }

  /**
   * Extract tool calls from response
   */
  #extractToolCalls(content: any[]): any[] {
    if (!content || content.length === 0) {
      return [];
    }

    // Find tool_use blocks
    const toolUseBlocks = content.filter(block => block.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      return [];
    }

    return toolUseBlocks.map(block => ({
      id: block.id,
      name: block.name,
      args: block.input
    }));
  }

  /**
   * Extract provider-specific parameters from model config
   * Excludes displayName, passes rest to Anthropic API
   */
  #extractProviderParams(): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};
    const { displayName, ...providerParams } = metadata;
    return providerParams;
  }

  /**
   * Translate `metadata.reasoning_effort` into Anthropic's reasoning surface.
   * Mutates `params` in place.
   *
   * `reasoning_effort` is the cross-provider knob written by the console Effort
   * control; on Anthropic there is no such top-level param — the equivalent is
   * `output_config.effort` plus `thinking: {type:'adaptive'}`. We map it only for
   * the reasoning family (Opus 4.7/4.8, Sonnet 5, Fable 5) and, when we do,
   * strip the legacy sampling knobs + `budget_tokens` that 400 alongside adaptive
   * thinking. When `reasoning_effort` is unset, this is a no-op — thinking stays
   * off and existing behavior is unchanged. `reasoning_effort` itself is always
   * removed from the outgoing params (it is never a valid Anthropic field).
   */
  #applyReasoningParams(params: Record<string, any>): void {
    const effort = params.reasoning_effort;
    delete params.reasoning_effort;

    if (!effort) return;

    if (!ANTHROPIC_REASONING_FAMILY.test(this.model || '')) {
      // e.g. Haiku 4.5 / Sonnet 4.5 — effort + adaptive thinking are rejected
      // there. Drop rather than send a request we know will 400.
      this.log(`[AnthropicExecutor] reasoning_effort ignored — ${this.model} is not a reasoning-family model`);
      return;
    }

    params.thinking = { type: 'adaptive' };
    params.output_config = { ...(params.output_config || {}), effort };
    for (const key of ANTHROPIC_REASONING_UNSUPPORTED_PARAMS) {
      delete params[key];
    }
  }
}

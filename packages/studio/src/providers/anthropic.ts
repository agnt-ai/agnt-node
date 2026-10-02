/**
 * AnthropicExecutor - Provider adapter for Anthropic models
 *
 * Uses native @anthropic-ai/sdk (not LangChain)
 */

import Anthropic from '@anthropic-ai/sdk';
import BaseExecutor from '../BaseExecutor.js';
import { anthropicSupportsForcedTools, isAnthropicPrefixMismatch } from './anthropicThinking.js';
import { nativeItems, legacyParts, requestReasoningConfig } from './nativeState.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { fileToAnthropicDocument } from './fileAttachment.js';
import { streamWithRetry, STREAM_ABSOLUTE_BACKSTOP_MS } from './streaming.js';

/**
 * Claude's "reasoning family" — the current models whose reasoning is driven by
 * adaptive thinking + `output_config.effort`, and which REJECT the legacy
 * sampling knobs (`temperature`/`top_p`/`top_k`) and `budget_tokens` with a 400.
 * On these models thinking is OFF unless `thinking: {type:'adaptive'}` is sent
 * explicitly (Opus 4.7/4.8), so effort has no effect without it. Older Claude
 * models use a separate legacy budget mapping below.
 * Confirmed against the claude-api reference (2026-07-21).
 */
const ANTHROPIC_REASONING_FAMILY = /^claude-(opus-5|opus-4-8|opus-4-7|sonnet-5|fable-5|mythos-5)(-|$)/i;

/** Legacy sampling knobs the reasoning family rejects (400) alongside adaptive thinking. */
const ANTHROPIC_REASONING_UNSUPPORTED_PARAMS = ['temperature', 'top_p', 'top_k', 'budget_tokens'];

/**
 * Older Claude models carved out of ANTHROPIC_REASONING_FAMILY above (see its
 * comment) that still support extended thinking, but only via the legacy
 * `thinking: {type:'enabled', budget_tokens:N}` form — no adaptive thinking,
 * no `output_config.effort`. Left unset, these models run with thinking fully
 * OFF, which (per Anthropic's own docs) makes them more prone to writing a
 * tool call into visible text/tool-argument strings instead of a real
 * `tool_use` block. Confirmed live 2026-08-20: a workflow-mode claude-haiku-4-5
 * run leaked a `finish_agent_run` call as pseudo-XML text twice in one run,
 * burning 3 extra turns before a hard safety-gate intervened.
 */
const ANTHROPIC_LEGACY_THINKING_FAMILY = /^claude-(haiku-4-5|sonnet-4-5|opus-4-6|opus-4-5)(-|$)/i;

/** reasoning_effort tier -> target legacy thinking budget_tokens, before
 * clamping to this request's max_tokens. Mirrors the tier names accepted by
 * output_config.effort (low/medium/high/xhigh/max) for the reasoning family. */
const LEGACY_THINKING_BUDGET_BY_EFFORT: Record<string, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};
const LEGACY_THINKING_BUDGET_DEFAULT = 4096;
/** Anthropic's own floor for budget_tokens. */
const LEGACY_THINKING_MIN_BUDGET = 1024;
/** Reserve this many max_tokens for the actual answer after thinking — budget_tokens must be strictly less than max_tokens. */
const LEGACY_THINKING_OUTPUT_HEADROOM = 1024;

/** Leaked pseudo-XML tool-call syntax (`<function_calls><invoke name="...">`,
 * or a bare `<invoke name="...">` with no wrapper — observed 2026-08-27,
 * incident where the wrapper was absent and the old wrapper-required pattern
 * missed it) that some models occasionally emit instead of a real tool_use
 * block — observed both in top-level visible text and, more often in
 * practice, stuffed inside a string-valued argument of an otherwise-real
 * tool call. */
const LEAKED_TOOL_CALL_PATTERN = /<invoke\s+name=["']/i;

export default class AnthropicExecutor extends BaseExecutor {
  private client: Anthropic;
  private prefixMismatchDrop?: { provider: string; model: string };

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
    // Beta controls belong in the header, not in the Messages body. This is
    // opt-in observation/policy: a header alone does not change mismatch handling.
    const beta = providerParams.anthropic_beta;
    delete providerParams.anthropic_beta;
    let betaValues: string[] = (Array.isArray(beta) ? beta : beta ? String(beta).split(',') : []).map(value => String(value).trim()).filter(Boolean);

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
    // it. Unset effort leaves the provider thinking default; sampling restrictions still apply.
    this.#applyReasoningParams(params);
    if (params.thinking?.type === 'enabled') {
      delete params.temperature;
      delete params.top_k;
      if (params.top_p != null && (params.top_p < 0.95 || params.top_p > 1)) delete params.top_p;
    }
    const explicitBinding = providerParams.thinking?.block_binding?.prefix_mismatch_behavior;
    const replayDrop = messages.some(message => nativeItems(message, this.provider, this.model, 'anthropic-content') && message.nativeState?.replayPolicy?.prefixMismatchBehavior === 'drop_block');
    const instanceDrop = this.prefixMismatchDrop?.provider === this.provider && this.prefixMismatchDrop?.model === this.model;
    const canBind = params.thinking?.type === 'adaptive' || (!params.thinking && /^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(-|$)/i.test(this.model));
    if (params.thinking?.block_binding) {
      betaValues = [...new Set([...betaValues, 'thinking-binding-controls-2026-08-01'])];
    }
    if (canBind && (explicitBinding === 'drop_block' || (!explicitBinding && (instanceDrop || replayDrop)))) {
      params.thinking = { ...(params.thinking || { type: 'adaptive' }), block_binding: { prefix_mismatch_behavior: 'drop_block' } };
      betaValues = [...new Set([...betaValues, 'thinking-binding-controls-2026-08-01'])];
    }
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
    if (!anthropicSupportsForcedTools(this.model, params.thinking) && (params.tool_choice?.type === 'any' || params.tool_choice?.type === 'tool')) {
      this.log(`[AnthropicExecutor] forced tool_choice (${params.tool_choice.type}) dropped — incompatible with ${this.model} thinking configuration`);
      delete params.tool_choice;
    }

    // Call Anthropic API — STREAMED. `messages.stream()` accumulates text and
    // tool_use (partial_json) deltas internally and `finalMessage()` returns the
    // exact same assembled Message shape `messages.create()` would, so the usage
    // + extraction below is unchanged. We bump the idle timer on every stream
    // event; a healthily-progressing response never trips it. A mid-stream
    // failure (stall or network drop) discards the partial and retries the whole
    // prompt, up to the retry budget.
    this.debug(`[AnthropicExecutor] Final messages payload:\n${JSON.stringify({ system: params.system, messages: params.messages }, null, 2)}`);
    let requestParams = params;
    let prefixBindingRecovery: InvokeResult['prefixBindingRecovery'];
    const invokeRequest = () => streamWithRetry(
      async (guard) => {
        const stream = this.client.messages.stream(requestParams, { signal: guard.signal, ...(betaValues.length ? { headers: { 'anthropic-beta': betaValues.join(',') } } : {}) });
        stream.on('streamEvent', () => guard.bump());
        return await stream.finalMessage();
      },
      {
        externalSignal: options.signal,
        isRetryable: (err) => this.isRetryableError(err),
        log: (m) => this.log(m),
      }
    );

    let response;
    try {
      response = await invokeRequest();
    } catch (error) {
      // Retry the exact documented prefix error once. Explicit caller policy
      // wins; generic signature failures and unsupported modes remain errors.
      if (!isAnthropicPrefixMismatch(error) || explicitBinding || !canBind || params.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block') throw error;
      this.log('[AnthropicExecutor] prefix binding mismatch: retrying once with provider drop_block; prior reasoning may be dropped');
      prefixBindingRecovery = { attempted: true, reason: 'prefix_binding_mismatch', requestedBehavior: 'drop_block' };
      requestParams = { ...params, thinking: { ...(params.thinking || { type: 'adaptive' }), block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
      betaValues = [...new Set([...betaValues, 'thinking-binding-controls-2026-08-01'])];
      response = await invokeRequest();
      this.prefixMismatchDrop = { provider: this.provider, model: this.model };
    }

    // Format response to match expected structure
    const usageTyped = response.usage as typeof response.usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens_details?: { thinking_tokens?: number };
    };
    // Anthropic reports thinking tokens as a detail within the inclusive output
    // total. Carry it as an optional observation, never as an extra billable
    // bucket: output_tokens remains the authoritative total for cost and trace
    // accounting. The API can omit the detail, while an explicit zero is valid.
    const thinkingTokens = usageTyped.output_tokens_details?.thinking_tokens;
    // Preserve thinking blocks verbatim so they can be echoed back unchanged on
    // the next same-model turn — Anthropic requires this during tool use with
    // thinking on, or the following request 400s. Kept in `rawParts` (the same
    // channel the Google adapter uses for thoughtSignatures) and undefined when
    // thinking is off, so non-reasoning turns carry nothing.
    const reasoningBlocks = (response.content || []).filter(
      (b: any) => b?.type === 'thinking' || b?.type === 'redacted_thinking'
    );

    const reasoningSummary = reasoningBlocks.filter((block: any) => block.type === 'thinking' && block.thinking).map((block: any) => ({ type: 'summary_text' as const, text: block.thinking }));
    const transformations = (response as any).input_transformations;
    const inputTransformations = Array.isArray(transformations) ? transformations
      .filter((entry: any) => entry && typeof entry.type === 'string' && typeof entry.path === 'string' && typeof entry.reason === 'string')
      .map((entry: any) => ({ type: entry.type, path: entry.path, reason: entry.reason })) : undefined;
    const extractedText = this.#extractTextContent(response.content);
    const extractedToolCalls = this.#extractToolCalls(response.content);
    this.#warnIfLeakedToolCall(extractedText, extractedToolCalls);

    return {
      reasoningConfig: requestReasoningConfig(this.provider, this.model, requestParams),
      ...(inputTransformations ? { inputTransformations } : {}),
      ...(prefixBindingRecovery ? { prefixBindingRecovery } : {}),
      message: {
        role: 'assistant',
        content: extractedText,
        tool_calls: extractedToolCalls,
        nativeState: { provider: this.provider, model: this.model, format: 'anthropic-content', items: response.content || [], ...(requestParams.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block' ? { replayPolicy: { prefixMismatchBehavior: 'drop_block' as const } } : {}) },
        ...(reasoningSummary.length ? { reasoningSummary } : {}),
        ...(reasoningBlocks.length ? { rawParts: reasoningBlocks } : {})
      },
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: usageTyped.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usageTyped.cache_creation_input_tokens ?? 0,
        ...(typeof thinkingTokens === 'number' ? { reasoning_output_tokens: thinkingTokens } : {})
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
      const replay = nativeItems(msg, this.provider, this.model, 'anthropic-content');
      if (replay) {
        formatted.push({ role: 'assistant', content: [...replay] });
        continue;
      }
      const rawParts = legacyParts(msg, 'anthropic-content');

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
        if (rawParts && rawParts.length) {
          content.push(...rawParts);
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
      if (msg.role === 'assistant' && rawParts && rawParts.length) {
        const content: any[] = [...rawParts];
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
      args: structuredClone(block.input)
    }));
  }

  /**
   * Defensive observability for a known model failure mode: some models
   * occasionally write a tool call into visible text, or into a string-valued
   * argument of an otherwise-real tool call, as legacy pseudo-XML
   * (`<function_calls><invoke name="...">`) instead of a proper `tool_use`
   * block. The call never executes and nothing else surfaces this — it
   * silently wastes a turn (see `ANTHROPIC_LEGACY_THINKING_FAMILY` above for
   * the observed case and mitigation). This does NOT parse or recover the
   * leaked call — arbitrary XML parsing of untrusted model output shaped as a
   * tool call is its own injection-surface concern — it only logs so the
   * failure is visible in CloudWatch instead of only discoverable by reading a
   * full trace by hand.
   */
  #warnIfLeakedToolCall(text: string, toolCalls: any[]): void {
    let leaked: string | null = null;

    if (text && LEAKED_TOOL_CALL_PATTERN.test(text)) {
      leaked = text;
    } else {
      for (const call of toolCalls) {
        for (const value of Object.values(call?.args || {})) {
          if (typeof value === 'string' && LEAKED_TOOL_CALL_PATTERN.test(value)) {
            leaked = value;
            break;
          }
        }
        if (leaked) break;
      }
    }

    if (leaked) {
      this.log(`[AnthropicExecutor] Detected leaked tool call in model output — model: ${this.model}, likely a thinking-disabled tool-call-leak. Leaked text (truncated): ${leaked.slice(0, 500)}`);
    }
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
   * thinking. Unset effort leaves native thinking defaults unchanged. `reasoning_effort` itself is always
   * removed from the outgoing params (it is never a valid Anthropic field).
   */
  #applyReasoningParams(params: Record<string, any>): void {
    const effort = params.reasoning_effort;
    delete params.reasoning_effort;

    // Current adaptive model families reject sampling knobs on every request.
    const inFamily = ANTHROPIC_REASONING_FAMILY.test(this.model || '');
    if (inFamily) {
      for (const key of ANTHROPIC_REASONING_UNSUPPORTED_PARAMS) {
        delete params[key];
      }
    }

    if (!effort) return;

    // Explicit native mode/budget is authoritative. Display and binding alone
    // still allow the generic effort mapping to fill the mode.
    if (params.thinking?.type != null || params.thinking?.budget_tokens != null) {
      if (inFamily && params.thinking?.type === 'adaptive' && params.output_config?.effort == null) {
        params.output_config = { ...(params.output_config || {}), effort };
      }
      return;
    }

    if (inFamily) {
      params.thinking = { ...(params.thinking?.display ? { display: params.thinking.display } : {}), ...(params.thinking?.block_binding ? { block_binding: params.thinking.block_binding } : {}), type: 'adaptive' };
      params.output_config = { effort, ...(params.output_config || {}) };
      return;
    }

    if (ANTHROPIC_LEGACY_THINKING_FAMILY.test(this.model || '')) {
      // Legacy budget mapping; manual-thinking sampling constraints are applied
      // after this request is constructed.
      const maxTokens = params.max_tokens || 4096;
      const room = maxTokens - LEGACY_THINKING_OUTPUT_HEADROOM;
      if (room < LEGACY_THINKING_MIN_BUDGET) {
        // Not enough max_tokens headroom to fit even the minimum thinking
        // budget alongside a real answer — skip rather than send a request
        // that leaves no room for output.
        this.log(`[AnthropicExecutor] reasoning_effort ignored — ${this.model} max_tokens=${maxTokens} too small for legacy thinking budget`);
        return;
      }
      const target = LEGACY_THINKING_BUDGET_BY_EFFORT[effort] ?? LEGACY_THINKING_BUDGET_DEFAULT;
      const budgetTokens = Math.max(LEGACY_THINKING_MIN_BUDGET, Math.min(target, room));
      params.thinking = { ...(params.thinking?.display ? { display: params.thinking.display } : {}), ...(params.thinking?.block_binding ? { block_binding: params.thinking.block_binding } : {}), type: 'enabled', budget_tokens: budgetTokens };
      return;
    }

    // e.g. some other/unknown model — effort has no known mapping there.
    // Drop rather than send a request we know will 400.
    this.log(`[AnthropicExecutor] reasoning_effort ignored — ${this.model} is not a reasoning-family model`);
  }
}

/**
 * OpenAIExecutor - Provider adapter for OpenAI models
 *
 * Uses native openai SDK (not LangChain)
 */

import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { streamWithRetry, consumeOpenAIStream, STREAM_ABSOLUTE_BACKSTOP_MS } from './streaming.js';

/**
 * OpenAI's "reasoning family" models (o-series: o1, o3, o4, ...; gpt-5.x)
 * reject request params that were previously safe to send to every chat
 * model. Detected by prefix — there is no existing model-family classifier
 * elsewhere in this codebase to reuse (checked BaseExecutor.ts and the rest
 * of packages/studio/src; nothing matches gpt-5/o1/o3 model IDs).
 *
 * `gpt-4o` intentionally does NOT match: it starts with "gpt-4o", not "o1"/
 * "o3"/"o4", so the o-series regexes below don't fire on it.
 */
const REASONING_FAMILY_MODEL_PATTERNS: RegExp[] = [
  /^o1(-|$)/i,
  /^o3(-|$)/i,
  /^o4(-|$)/i,
  /^gpt-5([.-]|$)/i,
];

function isReasoningFamilyModel(model: string): boolean {
  const normalized = model || '';
  return REASONING_FAMILY_MODEL_PATTERNS.some(pattern => pattern.test(normalized));
}

export default class OpenAIExecutor extends BaseExecutor {
  private client: OpenAI;

  constructor(config: BaseExecutorConfig) {
    super(config);

    // Get OpenAI credentials
    const openaiCreds = this.credentials.openai;
    if (!openaiCreds) {
      throw new Error('[OpenAIExecutor] credentials.openai is required');
    }
    if (!openaiCreds.apiKey) {
      throw new Error('[OpenAIExecutor] credentials.openai.apiKey is required');
    }

    // Initialize OpenAI client
    this.client = new OpenAI({
      apiKey: openaiCreds.apiKey,
      // Absorb transient rate-limit (429) / 5xx / timeout spikes at the SDK
      // layer with exponential backoff before the executor's model-fallback
      // path. SDK default is 2; bump so a brief blip doesn't fail the run.
      // `invoke()` STREAMS and bounds the response with an inter-chunk IDLE
      // timeout, so a long-but-progressing turn never times out. The client
      // `timeout` is only the SDK's own total-request cap; set it to the
      // streaming absolute backstop so the SDK never kills a healthily-streaming
      // response — the idle timeout is the operative ceiling.
      maxRetries: 3,
      timeout: STREAM_ABSOLUTE_BACKSTOP_MS,
      dangerouslyAllowBrowser: openaiCreds.dangerouslyAllowBrowser
    });

    this.log(`[OpenAIExecutor] Initialized with model: ${this.model}`);
  }

  /**
   * Invoke OpenAI API
   * Returns: { message: { role, content, tool_calls }, usage: { input_tokens, output_tokens } }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    // Build request parameters
    const params: any = {
      model: this.model,
      messages: this.#formatMessages(messages),
    };

    // Add all provider-specific parameters from model config
    // This passes through any OpenAI API params: temperature, top_p, reasoning, etc.
    const providerParams = this.#extractProviderParams();
    Object.assign(params, providerParams);

    // Reasoning-family models (o1/o3/o4, gpt-5.x) use a different request
    // shape than the rest of the OpenAI chat-completions surface — translate/
    // strip in place before the request goes out. See #applyReasoningFamilyParams
    // for the full story (root-caused in agnt-backend log-sweep 2026-07-16,
    // findings #33/#34/#37).
    if (isReasoningFamilyModel(this.model)) {
      this.#applyReasoningFamilyParams(params);
    }

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map(t => this.#formatTool(t));
      // Allow parallel tool calls — the model can emit several tool calls in a
      // single turn. This is OpenAI's default; set explicitly so it can't
      // silently regress and to match parallel behavior across providers.
      params.parallel_tool_calls = true;
    }

    // Add tool_choice if specified
    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatToolChoice(options.tool_choice);
    }

    this.log('[OpenAIExecutor] Invoking:', {
      model: params.model,
      temperature: params.temperature,
      top_p: params.top_p,
      tools: params.tools?.length || 0
    });

    // Call OpenAI API — STREAMED. We reassemble the streamed deltas back into
    // the non-streamed completion shape (consumeOpenAIStream) so the usage +
    // extraction below is unchanged. `stream_options.include_usage` makes the
    // final chunk carry the same usage object the non-streamed call returns.
    // The idle timer is bumped on every chunk; a mid-stream failure discards the
    // partial and retries the whole prompt.
    const response = await streamWithRetry(
      async (guard) => {
        const stream = await this.client.chat.completions.create(
          { ...params, stream: true, stream_options: { include_usage: true } },
          { signal: guard.signal }
        );
        return await consumeOpenAIStream(stream as any, () => guard.bump());
      },
      {
        externalSignal: options.signal,
        isRetryable: (err) => this.isRetryableError(err),
        log: (m) => this.log(m),
      }
    );

    const choice = response.choices[0];
    const message = choice.message;

    // Format response to match expected structure
    const usageTyped = response.usage as typeof response.usage & {
      prompt_tokens_details?: { cached_tokens?: number };
    };
    // OpenAI's prompt_tokens INCLUDES the cached tokens (cached_tokens is a
    // subset of prompt_tokens), unlike Anthropic where input_tokens excludes
    // cache. Subtract the cached tokens out so input_tokens is the UNCACHED
    // count, making the four usage buckets disjoint across all providers. The
    // pipeline relies on this: the inclusive total is recovered by summation
    // (input + cache_read + cache_creation), and cost is the sum of disjoint
    // buckets — so cache reads must not also live inside input_tokens or they
    // get charged twice.
    const cachedTokens = usageTyped?.prompt_tokens_details?.cached_tokens ?? 0;
    // Streaming usage rides the final chunk (stream_options.include_usage). Real
    // OpenAI always sends it; guard so an OpenAI-compatible endpoint that omits
    // it degrades to zeros rather than crashing the run.
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    return {
      message: {
        role: message.role as Message['role'],
        content: message.content || '',
        tool_calls: this.#extractToolCalls(message.tool_calls)
      },
      usage: {
        input_tokens: Math.max(0, promptTokens - cachedTokens),
        output_tokens: completionTokens,
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0
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
   * Format messages for OpenAI API
   */
  #formatMessages(messages: Message[]): any[] {
    return messages.map(msg => {
      // Handle tool messages
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content
        };
      }

      // An assistant message that made tool calls must carry them back in
      // OpenAI wire format when history is replayed, or the following tool
      // result 400s ("tool_call_id does not match any tool call in the
      // preceding assistant messages"). Canonical ToolCall { id, name, args } →
      // { id, type:'function', function:{ name, arguments: JSON-string } }.
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content ?? '',
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
            },
          })),
        };
      }

      // Handle regular messages
      return {
        role: msg.role,
        content: msg.content
      };
    });
  }

  /**
   * Format tool definition for OpenAI
   * OpenAI expects: { type: "function", function: { name, description, parameters } }
   */
  #formatTool(tool: any): any {
    // Already in OpenAI format: { type: "function", function: { name, description, parameters } }
    if (tool.type === 'function' && tool.function) {
      return tool;
    }

    // If has function field but no type (partial OpenAI format)
    if (tool.function) {
      return {
        type: 'function',
        function: tool.function
      };
    }

    // Anthropic format: { name, description, input_schema } - convert to OpenAI
    if (tool.input_schema) {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema
        }
      };
    }

    // Studio format: { name, description, parameters } - convert to OpenAI format
    if (tool.parameters) {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters
        }
      };
    }

    // Fallback: wrap in OpenAI format
    this.log('[OpenAIExecutor] Warning: Unrecognized tool format:', JSON.stringify(tool));
    return {
      type: 'function',
      function: {
        name: tool.name || 'unknown',
        description: tool.description || '',
        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} }
      }
    };
  }

  /**
   * Format tool_choice for OpenAI
   */
  #formatToolChoice(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      // "required" or "any" -> "required"
      if (toolChoice === 'required' || toolChoice === 'any') {
        return 'required';
      }
      return 'auto';
    }

    // If it's a specific tool: { type: "function", function: { name: "..." } }
    if (toolChoice.type === 'function' || toolChoice.function?.name) {
      return toolChoice;
    }

    // Anthropic format: { type: "tool", name: "..." }
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return {
        type: 'function',
        function: { name: toolChoice.name }
      };
    }

    return 'auto';
  }

  /**
   * Extract tool calls from OpenAI response
   */
  #extractToolCalls(toolCalls: any[] | undefined): any[] {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    // Guard the args parse: a model that emits malformed/truncated JSON in
    // tool arguments would otherwise throw here and kill the whole run.
    return toolCalls.map(tc => {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        this.log(`[OpenAIExecutor] tool "${tc.function?.name}" returned unparseable arguments; using {}:`, tc.function?.arguments);
      }
      return { id: tc.id, name: tc.function.name, args };
    });
  }

  /**
   * Extract provider-specific parameters from model config
   * Excludes displayName, passes rest to OpenAI API
   */
  #extractProviderParams(): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};
    const { displayName, ...providerParams } = metadata;
    return providerParams;
  }

  /**
   * Normalize outgoing request params for OpenAI's "reasoning family" models
   * (o1/o3/o4, gpt-5.x). Mutates `params` in place.
   *
   * Root cause (agnt-backend log-sweep 2026-07-16, findings #33/#34/#37):
   * OpenAIExecutor had ZERO per-model param translation — it blindly passed an
   * account's model-strategy `metadata` object through as literal OpenAI
   * request params (see #extractProviderParams above). An account's
   * model-strategy metadata for `openai/gpt-5.4` carried `max_tokens`
   * (mirroring the convention used for Anthropic models, where `max_tokens` is
   * still correct), and the cross-provider fallback path (Anthropic overload →
   * OpenAI safety net) immediately 400'd:
   *   "Unsupported parameter: 'max_tokens' is not supported with this model.
   *    Use 'max_completion_tokens' instead."
   * i.e. the one time this fallback was needed in prod, it was itself broken.
   *
   * `max_tokens` → `max_completion_tokens`: OpenAI's own SDK types mark
   * `max_tokens` deprecated and explicitly "not compatible with o-series
   * models" (node_modules/openai/resources/chat/completions/completions.d.ts).
   *
   * temperature/top_p (and the other legacy sampling knobs below): dropped
   * defensively, not just noted-as-a-TODO — corroborated by OpenAI's own
   * community forum, openai-python issue #2072, and third-party integration
   * bug reports (LibreChat #10737, lobe-chat #11332) all describing the same
   * "Unsupported parameter: 'temperature'" 400 on o1/o3/gpt-5 family models.
   * These models run internal reasoning/verification passes that classic
   * sampling params would destabilize, so OpenAI disabled them outright rather
   * than just deprecating them. If a model-strategy needs to steer a reasoning
   * model's output, the supported knobs are `reasoning_effort` / `verbosity`
   * (unaffected — they pass through #extractProviderParams unchanged since
   * they aren't in the strip list below).
   */
  #applyReasoningFamilyParams(params: Record<string, any>): void {
    if ('max_tokens' in params) {
      params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }

    for (const legacySamplingParam of [
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'n',
      'logprobs',
      'top_logprobs',
    ]) {
      delete params[legacySamplingParam];
    }
  }
}

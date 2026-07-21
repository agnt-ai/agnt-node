/**
 * OpenAIExecutor - Provider adapter for OpenAI models
 *
 * Uses native openai SDK (not LangChain)
 */

import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import {
  streamWithRetry,
  consumeOpenAIStream,
  consumeOpenAIResponsesStream,
  STREAM_ABSOLUTE_BACKSTOP_MS,
} from './streaming.js';

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

/**
 * Classic sampling knobs OpenAI's reasoning family rejects outright (not just
 * deprecates) — sending any of them 400s the request. Corroborated by OpenAI's
 * own community forum, openai-python #2072, and third-party bug reports
 * (LibreChat #10737, lobe-chat #11332): "Unsupported parameter: 'temperature'"
 * on o1/o3/gpt-5. These models run internal reasoning passes that sampling
 * params would destabilize. Stripped from the Responses request; the supported
 * steering knobs are `reasoning.effort` and `text.verbosity`.
 */
const REASONING_UNSUPPORTED_SAMPLING_PARAMS = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'n',
  'logprobs',
  'top_logprobs',
];

/**
 * Metadata keys the Responses builder translates into their Responses-API
 * home rather than passing through as a top-level request param (where they'd
 * 400 — Chat Completions and Responses spell these differently). See
 * #buildResponsesRequest.
 */
const RESPONSES_TRANSLATED_METADATA_KEYS = [
  'displayName',
  'reasoning_effort',
  'verbosity',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
];

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
    // Reasoning-family models (o1/o3/o4, gpt-5.x) are served over the OpenAI
    // Responses API (/v1/responses), not Chat Completions. Chat Completions
    // rejects the combination that matters most for these models — function
    // tools + reasoning_effort — with a hard 400 ("Function tools with
    // reasoning_effort are not supported ... in /v1/chat/completions. To use
    // function tools, use /v1/responses or set reasoning_effort to 'none'").
    // Since our runs are tool-heavy AND want effort control, we route the whole
    // reasoning family through /v1/responses. Everything else stays on the
    // proven streamed Chat Completions path below.
    if (isReasoningFamilyModel(this.model)) {
      return this.#invokeResponses(messages, options);
    }

    // Build request parameters
    const params: any = {
      model: this.model,
      messages: this.#formatMessages(messages),
    };

    // Add all provider-specific parameters from model config
    // This passes through any OpenAI API params: temperature, top_p, reasoning, etc.
    const providerParams = this.#extractProviderParams();
    Object.assign(params, providerParams);

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
   * Invoke OpenAI's Responses API (/v1/responses) for reasoning-family models.
   * Same streamed idle-guard contract as the Chat Completions path — only the
   * request shape (input items instead of `messages`, flat function tools,
   * `reasoning.effort`/`text.verbosity`/`max_output_tokens`) and the response
   * shape (an `output[]` of items instead of `choices[0].message`) differ.
   */
  async #invokeResponses(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    const params = this.#buildResponsesRequest(messages, options);

    this.log('[OpenAIExecutor] Invoking (responses):', {
      model: params.model,
      effort: params.reasoning?.effort,
      tools: params.tools?.length || 0,
    });

    // Streamed, folded back into the terminal Response object (see
    // consumeOpenAIResponsesStream). The idle timer is bumped on every event;
    // a mid-stream failure discards the partial and retries the whole prompt.
    const response = await streamWithRetry(
      async (guard) => {
        const stream = await this.client.responses.create(
          { ...params, stream: true } as any,
          { signal: guard.signal }
        );
        return await consumeOpenAIResponsesStream(stream as any, () => guard.bump());
      },
      {
        externalSignal: options.signal,
        isRetryable: (err) => this.isRetryableError(err),
        log: (m) => this.log(m),
      }
    );

    return this.#formatResponsesResult(response);
  }

  /**
   * Build the /v1/responses request from canonical messages + invoke options.
   *
   * Metadata is NOT spread through blindly (that blind passthrough is what 400'd
   * the reasoning family on Chat Completions — see the sampling-strip note). We
   * translate the knobs that live somewhere different on Responses and pass the
   * rest through:
   *   reasoning_effort           → reasoning.effort
   *   verbosity                  → text.verbosity
   *   max_tokens / *_completion_ → max_output_tokens
   *   temperature/top_p/…        → dropped (rejected by the reasoning family)
   */
  #buildResponsesRequest(messages: Message[], options: InvokeOptions): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};

    const params: Record<string, any> = {
      model: this.model,
      input: this.#formatResponsesInput(messages),
      // Stateless: we replay the full conversation on every turn, so there's no
      // reason to have OpenAI persist server-side response state.
      store: false,
    };

    // Pass through any metadata param that isn't translated below or a rejected
    // sampling knob — keeps forward-compat for genuine Responses params without
    // re-introducing the 400.
    for (const [key, value] of Object.entries(metadata)) {
      if (RESPONSES_TRANSLATED_METADATA_KEYS.includes(key)) continue;
      if (REASONING_UNSUPPORTED_SAMPLING_PARAMS.includes(key)) continue;
      params[key] = value;
    }

    if (metadata.reasoning_effort) {
      params.reasoning = { ...(params.reasoning || {}), effort: metadata.reasoning_effort };
    }
    if (metadata.verbosity) {
      params.text = { ...(params.text || {}), verbosity: metadata.verbosity };
    }
    const maxOut = metadata.max_output_tokens ?? metadata.max_completion_tokens ?? metadata.max_tokens;
    if (maxOut != null) {
      params.max_output_tokens = maxOut;
    }

    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map(t => this.#formatResponsesTool(t));
      // Match the Chat Completions path: allow several tool calls in one turn.
      params.parallel_tool_calls = true;
    }

    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatResponsesToolChoice(options.tool_choice);
    }

    return params;
  }

  /**
   * Canonical messages → Responses `input` items. The Responses API models a
   * turn's tool calls and their results as first-class `function_call` /
   * `function_call_output` items keyed by `call_id`, rather than Chat
   * Completions' assistant `tool_calls` array + `role:'tool'` messages.
   */
  #formatResponsesInput(messages: Message[]): any[] {
    const input: any[] = [];

    for (const msg of messages) {
      // Tool result → function_call_output, referenced by the originating
      // tool call's id. `output` must be a JSON string.
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output:
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
        });
        continue;
      }

      // Assistant turn that made tool calls: emit any text first, then one
      // function_call item per call so a later function_call_output can bind to
      // its call_id.
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        if (msg.content) {
          input.push({ role: 'assistant', content: this.#formatResponsesContent(msg.content, 'assistant') });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
          });
        }
        continue;
      }

      // Plain message (system/user/assistant text or multimodal parts).
      input.push({
        role: msg.role,
        content: this.#formatResponsesContent(msg.content, msg.role),
      });
    }

    return input;
  }

  /**
   * Normalize message content for a Responses input item. Strings pass through.
   * Chat-Completions-style content parts are remapped to the Responses part
   * types (text → input_text, image_url → input_image); assistant text parts
   * use output_text. Unknown parts pass through untouched.
   */
  #formatResponsesContent(content: string | any[], role: Message['role']): any {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content ?? '';

    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    return content.map(part => {
      if (!part || typeof part !== 'object') return part;
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        return { type: textType, text: part.text ?? '' };
      }
      if (part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        return { type: 'input_image', image_url: url };
      }
      return part;
    });
  }

  /**
   * Format a tool definition for the Responses API. Unlike Chat Completions
   * (`{ type:'function', function:{ name, description, parameters } }`), Responses
   * flattens the function fields to the top level. `strict:false` mirrors the
   * Chat Completions default — our tool schemas aren't authored to OpenAI's
   * strict-mode constraints, and strict:true would reject them.
   */
  #formatResponsesTool(tool: any): any {
    // Nested Chat-Completions shape → flatten.
    const fn = tool?.function ?? tool;
    const parameters = fn.parameters ?? tool.input_schema ?? { type: 'object', properties: {} };
    return {
      type: 'function',
      name: fn.name ?? tool.name ?? 'unknown',
      description: fn.description ?? tool.description ?? '',
      parameters,
      strict: false,
    };
  }

  /**
   * Format tool_choice for the Responses API: 'required'/'auto'/'none' strings,
   * or `{ type:'function', name }` (flat — no nested `function` wrapper).
   */
  #formatResponsesToolChoice(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      if (toolChoice === 'required' || toolChoice === 'any') return 'required';
      if (toolChoice === 'none') return 'none';
      return 'auto';
    }
    const name = toolChoice?.function?.name ?? toolChoice?.name;
    if (name) return { type: 'function', name };
    return 'auto';
  }

  /**
   * Map a terminal Responses `output[]` + usage back into the executor's
   * InvokeResult. Assistant `message` items contribute text (output_text /
   * refusal parts); `function_call` items become canonical tool calls keyed by
   * their `call_id` (the id a later function_call_output must reference).
   */
  #formatResponsesResult(response: any): InvokeResult {
    let content = '';
    const tool_calls: Array<{ id: string; name: string; args: Record<string, any> }> = [];

    for (const item of response?.output ?? []) {
      if (item?.type === 'message') {
        for (const part of item.content ?? []) {
          if (part?.type === 'output_text' && typeof part.text === 'string') content += part.text;
          else if (part?.type === 'refusal' && typeof part.refusal === 'string') content += part.refusal;
        }
      } else if (item?.type === 'function_call') {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(item.arguments || '{}');
        } catch {
          this.log(`[OpenAIExecutor] tool "${item.name}" returned unparseable arguments; using {}:`, item.arguments);
        }
        tool_calls.push({ id: item.call_id, name: item.name, args });
      }
      // reasoning items carry no user-visible content — skipped.
    }

    // Responses usage: input_tokens INCLUDES cached (input_tokens_details.
    // cached_tokens is a subset), like Chat Completions' prompt_tokens. Subtract
    // it out so the four usage buckets stay disjoint across providers.
    const usage = response?.usage ?? {};
    const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;

    return {
      message: {
        role: 'assistant',
        content,
        tool_calls,
      },
      usage: {
        input_tokens: Math.max(0, inputTokens - cachedTokens),
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0,
      },
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

}

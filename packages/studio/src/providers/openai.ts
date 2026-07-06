/**
 * OpenAIExecutor - Provider adapter for OpenAI models
 *
 * Uses native openai SDK (not LangChain)
 */

import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { streamWithRetry, consumeOpenAIStream, STREAM_ABSOLUTE_BACKSTOP_MS } from './streaming.js';

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
}

/**
 * AzureFoundryExecutor — provider adapter for Azure AI Foundry's unified
 * Model Inference API.
 *
 * Foundry's chat-completions endpoint speaks the OpenAI wire format (same
 * request/response shape as OpenAICompatibleExecutor), but auth is different:
 * a per-resource `endpoint`, an `api-key` header (not a bearer token), and a
 * required `api-version` query param on every call — so it gets its own
 * adapter rather than joining the OPENAI_COMPATIBLE_BASE_URLS registry.
 *
 * One Foundry resource can host OpenAI, Llama, Mistral, DeepSeek, and
 * Anthropic Claude models side by side — model selection is just the `model`
 * field in the request body (the Foundry deployment name), same as any other
 * OpenAI-wire provider.
 */

import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { streamWithRetry, consumeOpenAIStream, STREAM_ABSOLUTE_BACKSTOP_MS } from './streaming.js';

/** Default API version used when credentials.azureFoundry.apiVersion is omitted. */
const DEFAULT_AZURE_FOUNDRY_API_VERSION = '2024-05-01-preview';

export default class AzureFoundryExecutor extends BaseExecutor {
  private client: OpenAI;

  constructor(config: BaseExecutorConfig) {
    super(config);

    const creds = this.credentials.azureFoundry;
    if (!creds) {
      throw new Error('[AzureFoundryExecutor] credentials.azureFoundry is required');
    }
    if (!creds.apiKey) {
      throw new Error('[AzureFoundryExecutor] credentials.azureFoundry.apiKey is required');
    }
    if (!creds.endpoint) {
      throw new Error('[AzureFoundryExecutor] credentials.azureFoundry.endpoint is required');
    }

    const apiVersion = creds.apiVersion || DEFAULT_AZURE_FOUNDRY_API_VERSION;

    // invoke() STREAMS and bounds the response with an inter-chunk IDLE timeout
    // (see streaming.ts), so a long-but-progressing turn never races a total-
    // completion timeout. The client `timeout` here is only the SDK's own
    // absolute request cap; set it to the streaming backstop and let the idle
    // timeout be the operative ceiling. maxRetries matches the other adapters.
    this.client = new OpenAI({
      // The plain OpenAI client always sends `Authorization: Bearer <apiKey>`
      // alongside our explicit `api-key` header below — Foundry only looks at
      // `api-key` and ignores the extra Bearer header, so this is harmless.
      apiKey: creds.apiKey,
      baseURL: `${creds.endpoint.replace(/\/$/, '')}/models`,
      defaultHeaders: { 'api-key': creds.apiKey },
      defaultQuery: { 'api-version': apiVersion },
      maxRetries: 3,
      timeout: STREAM_ABSOLUTE_BACKSTOP_MS,
      dangerouslyAllowBrowser: creds.dangerouslyAllowBrowser,
    });

    this.log(`[AzureFoundryExecutor] Initialized @ ${creds.endpoint} (api-version ${apiVersion}) with model: ${this.model}`);
  }

  /**
   * Invoke the Azure AI Foundry chat-completions API.
   * Returns: { message: { role, content, tool_calls }, usage: {...disjoint buckets} }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    const params: any = {
      model: this.model,
      messages: this.#formatMessages(messages),
    };

    Object.assign(params, this.#extractProviderParams());

    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map(t => this.#formatTool(t));
      // Explicit parallel tool calls — OpenAI-wire default; set so it can't
      // silently regress and matches parallel behavior across providers.
      params.parallel_tool_calls = true;
    }

    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatToolChoice(options.tool_choice);
    }

    this.log('[AzureFoundryExecutor] Invoking:', {
      model: params.model,
      temperature: params.temperature,
      top_p: params.top_p,
      tools: params.tools?.length || 0,
    });

    // STREAMED: consumeOpenAIStream reassembles content + tool_call arg deltas
    // back into the exact non-streamed completion shape, so extraction below
    // is unchanged. Each chunk bumps the idle timer; a transient failure
    // retries the whole prompt. stream_options.include_usage rides usage on
    // the final chunk (guarded below — not every Foundry-hosted model honors it).
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

    // Same convention as OpenAI direct / OpenAI-compatible hosts: cached
    // tokens are a SUBSET of prompt_tokens, so subtract them out to keep the
    // four usage buckets disjoint across providers (otherwise a cache read
    // gets billed twice — once as input, once as read).
    const usageTyped = response.usage as typeof response.usage & {
      prompt_tokens_details?: { cached_tokens?: number };
    };
    const cachedTokens = usageTyped?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;

    const toolCalls = this.#extractToolCalls(message.tool_calls);
    const content = this.#resolveReasoningFallback(message, toolCalls, completionTokens);

    return {
      message: {
        role: message.role as Message['role'],
        content,
        tool_calls: toolCalls,
      },
      usage: {
        input_tokens: Math.max(0, promptTokens - cachedTokens),
        output_tokens: completionTokens,
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0,
      },
    };
  }

  /**
   * Recover the answer for reasoning models (e.g. DeepSeek-R1 hosted on
   * Foundry) that leave `content: null` on a stop turn and put the whole
   * answer in `reasoning_content` instead. Mirrors OpenAICompatibleExecutor's
   * fallback — same failure mode, same wire format.
   */
  #resolveReasoningFallback(
    message: { content?: string | null; reasoning_content?: string | null },
    toolCalls: any[],
    outputTokens: number
  ): string {
    const hasToolCalls = toolCalls.length > 0;
    const rawContent = message.content ?? '';
    const reasoning = (message.reasoning_content ?? '').trim();

    if (hasToolCalls) return rawContent || '';

    const stripped = this.#stripThinkBlock(rawContent);
    if (stripped.trim()) return stripped;

    if (reasoning) {
      this.log(`[AzureFoundryExecutor] content empty on stop turn — recovered answer from reasoning_content (${reasoning.length} chars)`);
      return reasoning;
    }

    if (outputTokens > 0) {
      throw this.#malformedEmptyResponseError(outputTokens);
    }

    return '';
  }

  #stripThinkBlock(text: string): string {
    if (!text) return '';
    const closed = text.replace(/^\s*<think>[\s\S]*?<\/think>/i, '');
    if (closed !== text) return closed.trim();
    if (/^\s*<think>/i.test(text)) return '';
    return text;
  }

  /** A retryable error for a productive-but-empty response. Given status 502 so
   *  BaseExecutor.isRetryableError classifies it as a transient upstream fault —
   *  routes it through both the in-stream retry and cross-model fallback. */
  #malformedEmptyResponseError(outputTokens: number): Error {
    const err: any = new Error(
      `[AzureFoundryExecutor] malformed response: ${outputTokens} output tokens but empty content, no reasoning_content, and no tool_calls`
    );
    err.status = 502;
    err.isMalformedEmptyResponse = true;
    return err;
  }

  hasToolCalls(message: Message): boolean {
    return Boolean(message?.tool_calls && message.tool_calls.length > 0);
  }

  /** Format messages for the OpenAI wire format. */
  #formatMessages(messages: Message[]): any[] {
    return messages.map(msg => {
      if (msg.role === 'tool') {
        return { role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content };
      }
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
      return { role: msg.role, content: msg.content };
    });
  }

  /** Format a tool definition to OpenAI format from any of our known shapes. */
  #formatTool(tool: any): any {
    if (tool.type === 'function' && tool.function) return tool;
    if (tool.function) return { type: 'function', function: tool.function };
    if (tool.input_schema) {
      return {
        type: 'function',
        function: { name: tool.name, description: tool.description || '', parameters: tool.input_schema },
      };
    }
    if (tool.parameters) {
      return {
        type: 'function',
        function: { name: tool.name, description: tool.description || '', parameters: tool.parameters },
      };
    }
    this.log('[AzureFoundryExecutor] Warning: Unrecognized tool format:', JSON.stringify(tool));
    return {
      type: 'function',
      function: {
        name: tool.name || 'unknown',
        description: tool.description || '',
        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
      },
    };
  }

  /** Format tool_choice to OpenAI format. */
  #formatToolChoice(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      if (toolChoice === 'required' || toolChoice === 'any') return 'required';
      return 'auto';
    }
    if (toolChoice.type === 'function' || toolChoice.function?.name) return toolChoice;
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    return 'auto';
  }

  /** Extract tool calls, degrading to empty args on unparseable JSON rather
   *  than throwing and killing the whole run. */
  #extractToolCalls(toolCalls: any[] | undefined): any[] {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map(tc => {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        this.log(`[AzureFoundryExecutor] tool "${tc.function?.name}" returned unparseable arguments; using {}:`, tc.function?.arguments);
      }
      return { id: tc.id, name: tc.function.name, args };
    });
  }

  /** Provider-call params from the model config (top-level fields the console
   *  strategy editor writes, plus raw metadata overrides like top_p). */
  #extractProviderParams(): Record<string, any> {
    const cfg = this.primaryModelConfig as any;
    const { displayName, ...metadataParams } = cfg.metadata || {};
    const params: Record<string, any> = {};
    if (cfg.temperature != null) params.temperature = cfg.temperature;
    if (cfg.maxTokens != null) params.max_tokens = cfg.maxTokens;
    return { ...params, ...metadataParams };
  }
}

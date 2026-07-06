/**
 * OpenAICompatibleExecutor — shared adapter for OpenAI-compatible providers
 *
 * One adapter for every provider that speaks the OpenAI Chat Completions wire
 * format: Together AI (Kimi / Qwen), Fireworks, DeepInfra, DeepSeek, and any
 * future open-model host. Per-provider differences — base URL, credentials,
 * model IDs, pricing, cache behavior — live in CONFIG, never in code:
 *
 *   - baseURL:  resolved from OPENAI_COMPATIBLE_BASE_URLS[provider], overridable
 *               by credentials[provider].baseURL or model metadata.baseURL.
 *   - apiKey:   credentials[provider].apiKey (via the existing secret manager;
 *               never stored in manifest/config rows).
 *   - model:    manifest.spec.models[].model.
 *   - params:   manifest.spec.models[].metadata (temperature, top_p, …).
 *
 * Adding a new OpenAI-compatible provider is therefore a config + credentials
 * change (new AiModel row + creds entry), with no new adapter code required —
 * unless it needs a base URL we don't know, which is a one-line registry entry.
 *
 * CACHING: these providers do AUTOMATIC (best-effort) prefix caching — the
 * provider caches transparently, there is no billed cache write, and cached
 * reads are reported back in usage.prompt_tokens_details.cached_tokens. We map
 * that to cache_read_input_tokens and leave cache_creation_input_tokens at 0
 * (there is no write concept here; the backend renders it as "—" / null based
 * on the model's cacheMode). We never send Anthropic-style cache_control blocks
 * — they are not part of the OpenAI wire format and must not leak through.
 */

import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { streamWithRetry, consumeOpenAIStream, STREAM_ABSOLUTE_BACKSTOP_MS } from './streaming.js';

/** Known OpenAI-compatible provider base URLs. A provider not listed here is
 *  still usable by supplying baseURL via credentials or model metadata. */
export const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  together:  'https://api.together.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  deepseek:  'https://api.deepseek.com/v1',
};

/** Providers routed through this adapter. Keep in sync with executorFactory. */
export const OPENAI_COMPATIBLE_PROVIDERS = new Set(Object.keys(OPENAI_COMPATIBLE_BASE_URLS));

export default class OpenAICompatibleExecutor extends BaseExecutor {
  private client: OpenAI;
  private providerName: string;

  constructor(config: BaseExecutorConfig) {
    super(config);

    // this.provider is set by BaseExecutor from the selected model config.
    this.providerName = (this.provider || '').toLowerCase();

    // Credentials are keyed by provider name. Real provider strings are
    // lowercase ('together', 'deepseek'), but tolerate the original casing too.
    const credMap = this.credentials as Record<string, any>;
    const creds = credMap[this.provider] ?? credMap[this.providerName];
    if (!creds) {
      throw new Error(`[OpenAICompatibleExecutor] credentials.${this.providerName} is required`);
    }
    if (!creds.apiKey) {
      throw new Error(`[OpenAICompatibleExecutor] credentials.${this.providerName}.apiKey is required`);
    }

    // baseURL resolution order: creds override → model metadata → registry.
    const metadata = ((this.primaryModelConfig as any).metadata || {}) as Record<string, any>;
    const baseURL =
      creds.baseURL ||
      metadata.baseURL ||
      OPENAI_COMPATIBLE_BASE_URLS[this.providerName];
    if (!baseURL) {
      throw new Error(
        `[OpenAICompatibleExecutor] no baseURL for provider "${this.providerName}" — ` +
        `add one to OPENAI_COMPATIBLE_BASE_URLS, credentials.${this.providerName}.baseURL, or model metadata.baseURL`
      );
    }

    // Initialize OpenAI-compatible client. invoke() STREAMS and bounds the
    // response with an inter-chunk IDLE timeout (see streaming.ts), so a
    // long-but-progressing turn — exactly Kimi doing multi-tool agentic work —
    // never races a total-completion timeout. The client `timeout` here is only
    // the SDK's own absolute request cap; set it to the streaming backstop and
    // let the idle timeout be the operative ceiling. maxRetries matches the
    // other streamed adapters.
    this.client = new OpenAI({
      apiKey: creds.apiKey,
      baseURL,
      maxRetries: 3,
      timeout: STREAM_ABSOLUTE_BACKSTOP_MS,
      dangerouslyAllowBrowser: creds.dangerouslyAllowBrowser,
    });

    this.log(`[OpenAICompatibleExecutor] Initialized ${this.providerName} @ ${baseURL} with model: ${this.model}`);
  }

  /**
   * Invoke the OpenAI-compatible API.
   * Returns: { message: { role, content, tool_calls }, usage: {...disjoint buckets} }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    const params: any = {
      model: this.model,
      messages: this.#formatMessages(messages),
    };

    // Pass through provider-specific params from model config (temperature, top_p, …).
    Object.assign(params, this.#extractProviderParams());

    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map(t => this.#formatTool(t));
      // Explicit parallel tool calls — OpenAI-compatible default; set so it
      // can't silently regress and matches parallel behavior across providers.
      params.parallel_tool_calls = true;
    }

    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatToolChoice(options.tool_choice);
    }

    this.log(`[OpenAICompatibleExecutor:${this.providerName}] Invoking:`, {
      model: params.model,
      temperature: params.temperature,
      top_p: params.top_p,
      tools: params.tools?.length || 0,
    });

    // STREAMED: consumeOpenAIStream reassembles content + tool_call arg deltas
    // back into the exact non-streamed completion shape, so the extraction below
    // is unchanged. Each chunk bumps the idle timer; a transient failure retries
    // the whole prompt. stream_options.include_usage rides usage on the final
    // chunk (guarded below — not all OpenAI-compatible hosts honor it).
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

    // Automatic-cache providers report cached prefix tokens as a SUBSET of
    // prompt_tokens (same convention as OpenAI direct). We subtract them out so
    // input_tokens is the UNCACHED count and the four usage buckets stay
    // disjoint across providers — otherwise cached reads get billed twice (once
    // as input, once as read). cache_creation is 0: these providers have no
    // billed write concept.
    //
    // Field location is NOT consistent across OpenAI-compatible hosts. Read all
    // known spellings so a cache hit is never silently missed (a missed field
    // reads as 0% hit rate → ~5x cost on our cache-heavy workload, and fails
    // silently — the spec's highest-risk case):
    //   - OpenAI direct / Together dedicated-inference: nested
    //     prompt_tokens_details.cached_tokens
    //   - Together OpenAI-compat surface: top-level cached_tokens
    //   - DeepSeek: prompt_cache_hit_tokens (with prompt_cache_miss_tokens)
    // All three are a SUBSET of prompt_tokens, so subtracting keeps input
    // uncached. NOTE: prompt_tokens-is-cache-inclusive must be confirmed with a
    // live Together call; if a host reports cached ADDITIVELY, this subtraction
    // under-counts input and needs a per-host flag.
    const usageTyped = response.usage as typeof response.usage & {
      cached_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    const cachedTokens =
      usageTyped?.prompt_tokens_details?.cached_tokens ??
      usageTyped?.cached_tokens ??
      usageTyped?.prompt_cache_hit_tokens ??
      0;
    // Streamed usage rides the final include_usage chunk. Real OpenAI/Together
    // send it, but guard so a host that omits it yields 0s instead of a crash
    // on response.usage!.  If a host silently drops usage, cost → 0 and the
    // credit engine under-bills — LIVE-VERIFY Together honors include_usage.
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;

    return {
      message: {
        role: message.role as Message['role'],
        content: message.content || '',
        tool_calls: this.#extractToolCalls(message.tool_calls),
      },
      usage: {
        input_tokens: Math.max(0, promptTokens - cachedTokens),
        output_tokens: completionTokens,
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0,
      },
    };
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
      // An assistant message that made tool calls MUST carry them back in
      // OpenAI wire format when the history is replayed on the next turn —
      // otherwise the following `tool` result has no matching tool call and the
      // provider 400s ("tool_call_id ... does not match any tool call in the
      // preceding assistant messages"), breaking every multi-turn tool loop.
      // Our canonical ToolCall is { id, name, args:object }; OpenAI wants
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
    this.log(`[OpenAICompatibleExecutor:${this.providerName}] Warning: Unrecognized tool format:`, JSON.stringify(tool));
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
    // Anthropic format: { type: "tool", name: "..." }
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    return 'auto';
  }

  /** Extract tool calls from an OpenAI-compatible response. */
  #extractToolCalls(toolCalls: any[] | undefined): any[] {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments),
    }));
  }

  /** Provider-call params from the model config. Sourced from the top-level
   *  V2ModelConfig fields (temperature/maxTokens — what the console strategy
   *  editor writes) AND `metadata` (advanced/raw OpenAI params like top_p). Every
   *  adapter historically read params from metadata only, so without the
   *  top-level fields the console's temperature field silently did nothing.
   *  metadata wins on a key collision (explicit per-call override). */
  #extractProviderParams(): Record<string, any> {
    const cfg = this.primaryModelConfig as any;
    const { displayName, baseURL, cacheMode, quantization, ...metadataParams } = cfg.metadata || {};
    const params: Record<string, any> = {};
    if (cfg.temperature != null) params.temperature = cfg.temperature;
    if (cfg.maxTokens != null) params.max_tokens = cfg.maxTokens;
    return { ...params, ...metadataParams };
  }
}

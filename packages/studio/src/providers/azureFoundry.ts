/**
 * AzureFoundryExecutor — provider adapter for Azure AI Foundry.
 *
 * Foundry fronts TWO distinct wire APIs behind the same "endpoint" concept,
 * and this adapter has to pick the right one per account:
 *
 *  - Model Inference API (non-OpenAI models — Llama, Mistral, DeepSeek,
 *    Claude): `{endpoint}/models/chat/completions?api-version=...`, a
 *    per-resource `api-key` header, and a required dated `api-version` query
 *    param. Same request/response shape as OpenAICompatibleExecutor.
 *
 *  - Azure OpenAI v1 API (real OpenAI models — gpt-4o, gpt-5.x, gpt-6.x):
 *    `{endpoint}/openai/v1`, no `api-version` param at all (deprecated by
 *    the v1 API — see api-version-lifecycle docs). This is the ONLY surface
 *    a gpt-5.x/gpt-6.x deployment answers on Foundry; the Model Inference
 *    API 400s/404s for it regardless of api-version. We detect this mode by
 *    the credentials' `endpoint` containing `/openai/v1` — the exact value
 *    Azure's own portal shows as "the openai endpoint" for these models.
 *
 * v1 mode additionally requires routing gpt-5.x/gpt-6.x through the
 * Responses API rather than Chat Completions: OpenAI's reasoning family
 * rejects function tools + reasoning_effort together on Chat Completions
 * (see openai.ts's identical REASONING_FAMILY_MODEL_PATTERNS /
 * #invokeResponses — Azure serves the exact same models, so the exact same
 * restriction applies). Mirrors that implementation; kept as its own copy
 * per this file's existing precedent of not sharing provider logic (see
 * openaiCompatible.ts's near-identical duplication note).
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

/** Default API version used when credentials.azureFoundry.apiVersion is omitted
 *  AND the endpoint is NOT a v1-style endpoint (Model Inference API only). */
const DEFAULT_AZURE_FOUNDRY_API_VERSION = '2024-05-01-preview';

/** Same reasoning-family detection as openai.ts — Azure hosts the identical
 *  models, so the identical Chat-Completions-vs-Responses split applies. */
const REASONING_FAMILY_MODEL_PATTERNS: RegExp[] = [
  /^o1(-|$)/i,
  /^o3(-|$)/i,
  /^o4(-|$)/i,
  /^gpt-5([.-]|$)/i,
  /^gpt-6([.-]|$)/i,
];

function isReasoningFamilyModel(model: string): boolean {
  const normalized = model || '';
  return REASONING_FAMILY_MODEL_PATTERNS.some(pattern => pattern.test(normalized));
}

/** Same rejected-params list as openai.ts's Responses builder. */
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

/** Same translated-metadata-keys list as openai.ts's Responses builder. */
const RESPONSES_TRANSLATED_METADATA_KEYS = [
  'displayName',
  'reasoning_effort',
  'verbosity',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
];

export default class AzureFoundryExecutor extends BaseExecutor {
  private client: OpenAI;
  private isV1Api: boolean;

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

    // Normalize away whatever trailing path the portal's copy-paste endpoint
    // carries (`/responses`, `/chat/completions`, a `?api-version=...` query
    // string some copy-paste sources leave attached, or nothing) down to the
    // resource root, then detect which wire API this endpoint targets.
    const trimmed = creds.endpoint.replace(/[?#].*$/, '').replace(/\/+$/, '');
    const v1Match = trimmed.match(/^(.*\/openai\/v1)(?:\/(?:responses|chat\/completions))?$/i);
    this.isV1Api = Boolean(v1Match);

    let baseURL: string;
    let apiVersion: string | undefined;
    if (this.isV1Api) {
      // v1 GA API: no api-version param at all (see api-version-lifecycle —
      // "api-version is no longer a required parameter with the v1 GA API").
      // Any apiVersion configured on the account is meaningless here and
      // intentionally ignored rather than sent and silently ignored by Azure.
      baseURL = v1Match![1];
    } else {
      baseURL = `${trimmed}/models`;
      apiVersion = creds.apiVersion || DEFAULT_AZURE_FOUNDRY_API_VERSION;
    }

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
      baseURL,
      defaultHeaders: { 'api-key': creds.apiKey },
      ...(apiVersion ? { defaultQuery: { 'api-version': apiVersion } } : {}),
      maxRetries: 3,
      timeout: STREAM_ABSOLUTE_BACKSTOP_MS,
      dangerouslyAllowBrowser: creds.dangerouslyAllowBrowser,
    });

    this.log(
      `[AzureFoundryExecutor] Initialized @ ${baseURL} ` +
      `(${this.isV1Api ? 'v1 API, no api-version' : `api-version ${apiVersion}`}) ` +
      `with model: ${this.model}`
    );
  }

  /**
   * Invoke the Azure AI Foundry chat-completions API.
   * Returns: { message: { role, content, tool_calls }, usage: {...disjoint buckets} }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    // Reasoning-family models (gpt-5.x, gpt-6.x) only answer tool calls +
    // reasoning_effort on the Responses API — identical restriction to
    // direct OpenAI (see openai.ts). The Model Inference API (`/models`) has
    // no Responses equivalent, so this only applies in v1 mode.
    if (this.isV1Api && isReasoningFamilyModel(this.model)) {
      return this.#invokeResponses(messages, options);
    }

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

  // ───────────────────────────────────────────────────────────────────────
  // Responses API path (v1 mode, gpt-5.x/gpt-6.x only) — ported from
  // OpenAIExecutor's identical implementation. See class doc comment.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Invoke the Responses API (`{v1BaseURL}/responses`) for reasoning-family
   * models. Same streamed idle-guard contract as the Chat Completions path —
   * only the request shape (input items instead of `messages`, flat function
   * tools, `reasoning.effort`/`text.verbosity`/`max_output_tokens`) and the
   * response shape (an `output[]` of items instead of `choices[0].message`)
   * differ.
   */
  async #invokeResponses(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    const params = this.#buildResponsesRequest(messages, options);

    this.log('[AzureFoundryExecutor] Invoking (responses):', {
      model: params.model,
      effort: params.reasoning?.effort,
      tools: params.tools?.length || 0,
    });

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

  /** Build the `/responses` request from canonical messages + invoke options.
   *  See openai.ts's identical method for the full rationale. */
  #buildResponsesRequest(messages: Message[], options: InvokeOptions): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};

    const params: Record<string, any> = {
      model: this.model,
      input: this.#formatResponsesInput(messages),
      store: false,
    };

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
      params.parallel_tool_calls = true;
    }

    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatResponsesToolChoice(options.tool_choice);
    }

    return params;
  }

  /** Canonical messages → Responses `input` items. */
  #formatResponsesInput(messages: Message[]): any[] {
    const input: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output:
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
        });
        continue;
      }

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

      input.push({
        role: msg.role,
        content: this.#formatResponsesContent(msg.content, msg.role),
      });
    }

    return input;
  }

  /** Normalize message content for a Responses input item. */
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

  /** Format a tool definition for the Responses API (flat, not nested under `function`). */
  #formatResponsesTool(tool: any): any {
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

  /** Format tool_choice for the Responses API. */
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

  /** Map a terminal Responses `output[]` + usage back into the executor's InvokeResult. */
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
          this.log(`[AzureFoundryExecutor] tool "${item.name}" returned unparseable arguments; using {}:`, item.arguments);
        }
        tool_calls.push({ id: item.call_id, name: item.name, args });
      }
    }

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
}

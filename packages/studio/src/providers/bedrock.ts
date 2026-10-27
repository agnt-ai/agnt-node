/**
 * BedrockExecutor - Provider adapter for AWS Bedrock models
 *
 * Uses native @aws-sdk/client-bedrock-runtime (not LangChain)
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import BaseExecutor from '../BaseExecutor.js';
import { StreamAbortError } from './streaming.js';
import { systemText, SYSTEM_PART_SEPARATOR } from './systemContent.js';
import { stableTailIndex, earlierTailIndex } from './cacheTail.js';
import { bedrockTakesCachePoints, breakpointsSwitchedOff } from './promptCacheCapabilities.js';
import { breakpointsRejected, markBreakpointsRejected } from './openaiPromptCache.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';
import { fileToBedrockDocument } from './fileAttachment.js';

/** Largest delay a Node timer honours (2^31-1 ms); anything above fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export default class BedrockExecutor extends BaseExecutor {
  private client: BedrockRuntimeClient;
  private region: string;

  constructor(config: BaseExecutorConfig) {
    super(config);

    // Get Bedrock credentials
    const bedrockCreds = this.credentials.bedrock;
    if (!bedrockCreds) {
      throw new Error('[BedrockExecutor] credentials.bedrock is required');
    }
    if (!bedrockCreds.region) {
      throw new Error('[BedrockExecutor] credentials.bedrock.region is required');
    }

    // Initialize Bedrock client
    const clientConfig: any = { region: bedrockCreds.region };

    // Add credentials if provided (optional - can use AWS SDK default credential chain)
    if (bedrockCreds.accessKeyId && bedrockCreds.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: bedrockCreds.accessKeyId,
        secretAccessKey: bedrockCreds.secretAccessKey
      };
    }

    this.client = new BedrockRuntimeClient(clientConfig);
    this.region = bedrockCreds.region;

    this.log(`[BedrockExecutor] Initialized with model: ${this.model}, region: ${this.region}`);
  }

  /**
   * Invoke Bedrock Converse API
   * Returns: { message: { role, content, tool_calls }, usage: { input_tokens, output_tokens } }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    // Extract provider-specific parameters
    const providerParams = this.#extractProviderParams();

    // Prompt caching (promptCacheCapabilities.ts). Claude models take explicit Converse `cachePoint` blocks: one after
    // the tools, one at the system prompt's static boundary, one at the conversation's stable tail and one at the
    // previous request's tail (cacheTail.ts), 4 in all, the most Bedrock allows. Nova and every other model rely on
    // Bedrock's implicit caching (Nova caches explicitly only within its first 20K tokens, which a long system
    // prompt alone exceeds). One-shot callers (`disableCache`), the caller's kill switch
    // (`prompt_cache_breakpoints: false`) and a model that rejected checkpoints in the last 15 minutes get none.
    const cachePoints = !options.disableCache
      && bedrockTakesCachePoints(this.model)
      && !breakpointsSwitchedOff(providerParams)
      && !breakpointsRejected('bedrock', this.model, this.region);

    // Extract system messages (Bedrock requires separate system parameter)
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m => systemText(m.content)).join(SYSTEM_PART_SEPARATOR);

    // Build request parameters
    const formatted = this.#formatMessages(messages);
    const params: any = {
      modelId: this.model,
      messages: formatted.messages,
      inferenceConfig: {
        maxTokens: providerParams.maxTokens || providerParams.max_tokens || 4096
      }
    };

    // Add system parameter if we have system messages
    if (systemContent) {
      params.system = cachePoints ? bedrockSystemWithCachePoint(systemMessages) : [{ text: systemContent }];
    }

    // Add temperature if defined
    if (providerParams.temperature !== undefined) {
      params.inferenceConfig.temperature = providerParams.temperature;
    }

    // Add top_p if defined
    if (providerParams.top_p !== undefined) {
      params.inferenceConfig.topP = providerParams.top_p;
    }

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      params.toolConfig = {
        tools: options.tools.map(t => this.#formatTool(t))
      };

      // Add tool_choice if specified
      if (options.tool_choice && options.tool_choice !== 'auto') {
        params.toolConfig.toolChoice = this.#formatToolChoice(options.tool_choice);
      }
      if (cachePoints) params.toolConfig.tools.push({ cachePoint: { ...CACHE_POINT } });
    }

    if (cachePoints) {
      const conversation = messages.filter(m => m.role !== 'system');
      const tail = stableTailIndex(conversation);
      const earlier = earlierTailIndex(conversation);
      const marks = [...new Set([tail, earlier].filter(i => i >= 0))]
        .map(i => formatted.ends[i])
        .filter((at): at is [number, number] => Array.isArray(at))
        .map(at => outsideToolResultRun(params.messages, at))
        .filter((at): at is [number, number] => Array.isArray(at))
        // Insert from the back so an earlier insertion never shifts a later one.
        .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
      const seen = new Set<string>();
      for (const [m, b] of marks) {
        const key = `${m}:${b}`;
        if (seen.has(key) || !params.messages[m]) continue;
        seen.add(key);
        params.messages[m].content.splice(b, 0, { cachePoint: { ...CACHE_POINT } });
      }
    }

    this.log('[BedrockExecutor] Invoking:', {
      model: params.modelId,
      temperature: params.inferenceConfig.temperature,
      top_p: params.inferenceConfig.topP,
      tools: params.toolConfig?.tools?.length || 0
    });

    // Call Bedrock Converse API.
    //
    // `abortSignal` is threaded so a cancelled run actually stops here. This
    // adapter is the one provider that does not stream through
    // streamWithRetry, so without it `cancel()` had no effect at all: the
    // request ran to completion and returned a normal success, which
    // invokeWithFallback would then accept and bill for work the caller had
    // already abandoned.
    //
    // It also has no stream guard, so the caller's deadlineAt is applied here:
    // the request is aborted when it passes and reported as a 'deadline' stop.
    const leftMs = Number.isFinite(options.deadlineAt) ? (options.deadlineAt as number) - Date.now() : Infinity;
    if (leftMs <= 0) throw new StreamAbortError('deadline', '[bedrock] deadline passed before attempt');
    // AbortSignal.timeout throws ERR_OUT_OF_RANGE on a non-integer delay, and Node
    // clamps a delay above 2^31-1 ms (~24.8 days) to 1 ms, which would abort at once.
    const deadlineSignal = Number.isFinite(leftMs)
      ? AbortSignal.timeout(Math.max(0, Math.min(Math.ceil(leftMs), MAX_TIMER_MS)))
      : undefined;
    // AbortSignal.any is Node 20.3+; on an older runtime the caller's signal alone still stops it.
    const abortSignal = !deadlineSignal ? options.signal
      : !options.signal ? deadlineSignal
        : typeof (AbortSignal as any).any === 'function' ? (AbortSignal as any).any([options.signal, deadlineSignal]) : options.signal;
    const send = async (p: any) => {
      try {
        return await this.client.send(new ConverseCommand(p), { abortSignal });
      } catch (error) {
        if (deadlineSignal?.aborted && !options.signal?.aborted) {
          throw Object.assign(new StreamAbortError('deadline', '[bedrock] deadline passed mid-request'), { cause: error });
        }
        throw error;
      }
    };
    let response: any;
    try {
      response = await send(params);
    } catch (error) {
      // A model or Region that does not take checkpoints answers 400 (ValidationException). Retry once without
      // them; only a retry that then succeeds turns them off for this model (15 minutes, logged at warn).
      if (!cachePoints || !isValidationError(error)) throw error;
      const plain = stripCachePoints(params);
      response = await send(plain);
      markBreakpointsRejected('bedrock', this.model, this.region);
    }

    // Format response to match expected structure
    const output = response.output;
    const message = output!.message;

    // Surface Converse's stopReason so the caller can see terminal conditions
    // that arrive as a SUCCESS. Notably `model_context_window_exceeded`: a
    // context-window overflow comes back as HTTP 200 with an empty output
    // message and no error string, so stopReason is the ONLY signal it happened.
    // Passed through verbatim and uninterpreted — what a stopReason should cause
    // is the caller's policy decision, not this adapter's. Spread so a response
    // without one is byte-identical to what we returned before.
    return {
      message: {
        role: 'assistant',
        content: this.#extractTextContent(message!.content),
        tool_calls: this.#extractToolCalls(message!.content)
      },
      // Converse reports cache reads and writes beside inputTokens, which then counts only the uncached rest, so
      // the buckets are already disjoint. Bedrock also caches implicitly with no checkpoints, so reads are read on
      // every model (dropping them under-billed every cached token).
      usage: {
        input_tokens: response.usage?.inputTokens ?? 0,
        output_tokens: response.usage?.outputTokens ?? 0,
        cache_read_input_tokens: Math.max(0, Number(response.usage?.cacheReadInputTokens) || 0),
        cache_creation_input_tokens: Math.max(0, Number(response.usage?.cacheWriteInputTokens) || 0)
      },
      ...(response.stopReason ? { stopReason: response.stopReason } : {})
    };
  }

  /**
   * Check if message has tool calls
   */
  hasToolCalls(message: Message): boolean {
    return Boolean(message?.tool_calls && message.tool_calls.length > 0);
  }

  /**
   * Format messages for Bedrock Converse API
   */
  #formatMessages(messages: Message[]): { messages: any[]; ends: Array<[number, number] | null> } {
    const formatted: any[] = [];
    // For each non-system source message: [formatted message, content index just after its last block], where a
    // cache checkpoint for "everything up to this message" goes. Tool results share one formatted message.
    const ends: Array<[number, number] | null> = [];

    for (const msg of messages) {
      // Skip system messages (handled separately in Bedrock)
      if (msg.role === 'system') {
        continue;
      }

      // Handle tool messages — Bedrock requires ALL tool results from a parallel
      // tool call batch to be in a single user message as multiple toolResult
      // content blocks. Merge consecutive tool messages into one.
      if (msg.role === 'tool') {
        let toolResultContent: any;
        if (typeof msg.content === 'string') {
          try {
            const parsed = JSON.parse(msg.content);
            toolResultContent = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? { json: parsed }
              : { text: msg.content };
          } catch {
            toolResultContent = { text: msg.content };
          }
        } else if (msg.content !== null && typeof msg.content === 'object' && !Array.isArray(msg.content)) {
          toolResultContent = { json: msg.content };
        } else {
          toolResultContent = { text: String(msg.content ?? '') };
        }
        const toolResultBlock = {
          toolResult: {
            toolUseId: msg.tool_call_id,
            content: [toolResultContent]
          }
        };
        // If the last formatted message is already a tool-result batch, append to it.
        const last = formatted[formatted.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.toolResult) {
          last.content.push(toolResultBlock);
        } else {
          formatted.push({ role: 'user', content: [toolResultBlock] });
        }
        ends.push([formatted.length - 1, formatted[formatted.length - 1].content.length]);
        continue;
      }

      // Handle user/assistant messages
      const contentBlocks: any[] = [];

      // Add text content if non-empty
      const textContent = typeof msg.content === 'string'
        ? msg.content
        : null;
      if (textContent) {
        contentBlocks.push(...(typeof msg.content === 'string'
          ? [{ text: msg.content }]
          : this.#formatContent(msg.content)));
      } else if (msg.content && typeof msg.content !== 'string') {
        contentBlocks.push(...this.#formatContent(msg.content));
      }

      // Add tool call blocks for assistant messages
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            toolUse: {
              toolUseId: tc.id,
              name: tc.name,
              input: tc.args || {}
            }
          });
        }
      }

      if (contentBlocks.length === 0) {
        contentBlocks.push({ text: ' ' });
      }

      // Converse rejects two messages of the same role in a row ("A conversation must alternate between user and
      // assistant roles"). A per-turn note right after the tool results is exactly that, so a same-role message is
      // appended to the previous one (after its blocks: tool results stay first).
      const prev = formatted[formatted.length - 1];
      if (prev && prev.role === msg.role && Array.isArray(prev.content)) {
        prev.content.push(...contentBlocks);
        ends.push([formatted.length - 1, prev.content.length]);
        continue;
      }
      formatted.push({
        role: msg.role,
        content: contentBlocks
      });
      ends.push([formatted.length - 1, contentBlocks.length]);
    }

    return { messages: formatted, ends };
  }

  /**
   * Format content blocks
   */
  #formatContent(content: any): any[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }

    if (Array.isArray(content)) {
      return content.map(item => {
        if (item.type === 'text') {
          return { text: item.text || item.content };
        }
        if (item.type === 'image_url') {
          // Bedrock expects images in a specific format
          // This should be handled by ImageCache before getting here
          this.log('[BedrockExecutor] Warning: Image processing not yet implemented');
          return null;
        }
        if (item.type === 'file') {
          // Cross-provider file block (e.g. PDF) → Bedrock Converse document.
          const doc = fileToBedrockDocument(item);
          if (doc) return doc;
          this.log('[BedrockExecutor] Warning: unsupported/invalid file block — dropping');
          return null;
        }
        return item;
      }).filter(Boolean);
    }

    return [{ text: String(content) }];
  }

  /**
   * Format tool definition for Bedrock
   */
  #formatTool(tool: any): any {
    // Tool might be in OpenAI format: { type: "function", function: { name, description, parameters } }
    // Or Anthropic format: { name, description, input_schema }
    // Or Studio format: { name, description, parameters }

    let toolSpec: any;

    // OpenAI format: { type: "function", function: { name, description, parameters } }
    if (tool.function) {
      toolSpec = {
        name: tool.function.name,
        description: tool.function.description || '',
        inputSchema: {
          json: tool.function.parameters || { type: 'object', properties: {} }
        }
      };
    }
    // Anthropic format: { name, description, input_schema }
    else if (tool.input_schema) {
      toolSpec = {
        name: tool.name,
        description: tool.description || '',
        inputSchema: {
          json: tool.input_schema
        }
      };
    }
    // Studio format: { name, description, parameters }
    else if (tool.parameters) {
      toolSpec = {
        name: tool.name,
        description: tool.description || '',
        inputSchema: {
          json: tool.parameters
        }
      };
    }
    // Fallback
    else {
      this.log('[BedrockExecutor] Warning: Unrecognized tool format:', JSON.stringify(tool));
      toolSpec = {
        name: tool.name || 'unknown',
        description: tool.description || '',
        inputSchema: {
          json: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
      };
    }

    return { toolSpec };
  }

  /**
   * Format tool_choice for Bedrock
   */
  #formatToolChoice(toolChoice: any): any {
    if (typeof toolChoice === 'string') {
      // `{ any: {} }` forces a tool call and allows parallel tool use — the
      // Converse API has no disable-parallel flag, so parallel is the default.
      if (toolChoice === 'required' || toolChoice === 'any') {
        return { any: {} };
      }
      return { auto: {} };
    }

    // Specific tool selection
    if (toolChoice.type === 'function' && toolChoice.function?.name) {
      return { tool: { name: toolChoice.function.name } };
    }

    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { tool: { name: toolChoice.name } };
    }

    return { auto: {} };
  }

  /**
   * Extract text content from response
   */
  #extractTextContent(content: any[] | undefined): string {
    if (!content || content.length === 0) {
      return '';
    }

    // Find text blocks
    const textBlocks = content.filter(block => block.text);
    if (textBlocks.length === 0) {
      return '';
    }

    return textBlocks.map(block => block.text).join('\n');
  }

  /**
   * Extract tool calls from response
   */
  #extractToolCalls(content: any[] | undefined): any[] {
    if (!content || content.length === 0) {
      return [];
    }

    // Find toolUse blocks
    const toolUseBlocks = content.filter(block => block.toolUse);
    if (toolUseBlocks.length === 0) {
      return [];
    }

    return toolUseBlocks.map(block => ({
      id: block.toolUse.toolUseId,
      name: block.toolUse.name,
      args: block.toolUse.input
    }));
  }

  /**
   * Extract provider-specific parameters from model config
   * Excludes displayName, passes rest to Bedrock API
   */
  #extractProviderParams(): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};
    const { displayName, ...providerParams } = metadata;
    return providerParams;
  }
}

const CACHE_POINT = { type: 'default' as const };

/**
 * Converse `system` with a checkpoint at the static boundary: one text block per system part (each later block
 * starting with the separator, so the model reads exactly the joined text), the checkpoint after the part marked
 * `cacheBoundary` (systemContent.ts), or after the last block when none is marked.
 */
export function bedrockSystemWithCachePoint(systemMessages: Message[]): any[] {
  const parts: Array<{ text: string; boundary: boolean }> = [];
  for (const m of systemMessages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content as any[]) {
        const text = typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '';
        if (text) parts.push({ text, boundary: part?.cacheBoundary === true });
      }
    } else {
      const text = systemText(m.content);
      if (text) parts.push({ text, boundary: false });
    }
  }
  if (!parts.length) return [];
  let at = -1;
  for (let i = 0; i < parts.length; i++) if (parts[i].boundary) at = i;
  if (at < 0) at = parts.length - 1;
  const blocks: any[] = [];
  parts.forEach((p, i) => {
    blocks.push({ text: i === 0 ? p.text : SYSTEM_PART_SEPARATOR + p.text });
    if (i === at) blocks.push({ cachePoint: { ...CACHE_POINT } });
  });
  return blocks;
}

/**
 * A checkpoint never goes between the toolResult blocks of one batch. When the stable tail ends mid-run (the batch's
 * later results are `releaseAfterRead`), the mark moves back to just before the run: to the end of the message before
 * it when the run opens its message (the assistant tool-use turn), so the cached prefix holds only stable content.
 * Moving it forward would cache the read-once results, which change on a later turn.
 */
export function outsideToolResultRun(messages: any[], [m, b]: [number, number]): [number, number] | null {
  const content = messages[m]?.content;
  if (!Array.isArray(content)) return null;
  if (!(b > 0 && b < content.length && content[b - 1]?.toolResult && content[b]?.toolResult)) return [m, b];
  let start = b - 1;
  while (start > 0 && content[start - 1]?.toolResult) start--;
  if (start > 0) return [m, start];
  if (m === 0 || !Array.isArray(messages[m - 1]?.content)) return null;
  return [m - 1, messages[m - 1].content.length];
}

/** The same request with every cachePoint block removed and system text blocks rejoined as one. */
function stripCachePoints(params: any): any {
  const out = { ...params };
  if (Array.isArray(params.system)) {
    const text = params.system.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('');
    out.system = text ? [{ text }] : undefined;
    if (!out.system) delete out.system;
  }
  if (params.toolConfig?.tools) out.toolConfig = { ...params.toolConfig, tools: params.toolConfig.tools.filter((t: any) => !t?.cachePoint) };
  out.messages = params.messages.map((m: any) => ({ ...m, content: m.content.filter((b: any) => !b?.cachePoint) }));
  return out;
}

function isValidationError(error: any): boolean {
  return error?.name === 'ValidationException' || error?.$metadata?.httpStatusCode === 400;
}


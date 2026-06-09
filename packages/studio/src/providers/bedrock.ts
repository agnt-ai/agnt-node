/**
 * BedrockExecutor - Provider adapter for AWS Bedrock models
 *
 * Uses native @aws-sdk/client-bedrock-runtime (not LangChain)
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';

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

    // Extract system messages (Bedrock requires separate system parameter)
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m => m.content).join('\n\n');

    // Build request parameters
    const params: any = {
      modelId: this.model,
      messages: this.#formatMessages(messages),
      inferenceConfig: {
        maxTokens: providerParams.maxTokens || providerParams.max_tokens || 4096
      }
    };

    // Add system parameter if we have system messages
    if (systemContent) {
      params.system = [{ text: systemContent }];
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
    }

    this.log('[BedrockExecutor] Invoking:', {
      model: params.modelId,
      temperature: params.inferenceConfig.temperature,
      top_p: params.inferenceConfig.topP,
      tools: params.toolConfig?.tools?.length || 0
    });

    // Call Bedrock Converse API
    const command = new ConverseCommand(params);
    const response = await this.client.send(command);

    // Format response to match expected structure
    const output = response.output;
    const message = output!.message;

    return {
      message: {
        role: 'assistant',
        content: this.#extractTextContent(message!.content),
        tool_calls: this.#extractToolCalls(message!.content)
      },
      usage: {
        input_tokens: response.usage!.inputTokens!,
        output_tokens: response.usage!.outputTokens!
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
   * Format messages for Bedrock Converse API
   */
  #formatMessages(messages: Message[]): any[] {
    const formatted: any[] = [];

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

      formatted.push({
        role: msg.role,
        content: contentBlocks
      });
    }

    return formatted;
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

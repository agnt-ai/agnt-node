/**
 * AnthropicExecutor - Provider adapter for Anthropic models
 *
 * Uses native @anthropic-ai/sdk (not LangChain)
 */

import Anthropic from '@anthropic-ai/sdk';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';

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

    // Add system parameter if we have system messages
    if (systemContent) {
      params.system = systemContent;
    }

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map((t: any) => {
        return this.#formatTool(t);
      });
    }

    // Add tool_choice if specified
    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatToolChoice(options.tool_choice);
    }

    // Call Anthropic API
    const response = await this.client.messages.create(params);

    // Format response to match expected structure
    return {
      message: {
        role: 'assistant',
        content: this.#extractTextContent(response.content),
        tool_calls: this.#extractToolCalls(response.content)
      },
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
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
        return { type: 'any', disable_parallel_tool_use: true };
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
}

/**
 * DeepSeekExecutor - Provider adapter for DeepSeek models
 *
 * DeepSeek uses OpenAI-compatible API
 */

import OpenAI from 'openai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';

export default class DeepSeekExecutor extends BaseExecutor {
  private client: OpenAI;

  constructor(config: BaseExecutorConfig) {
    super(config);

    // Get DeepSeek credentials
    const deepseekCreds = this.credentials.deepseek;
    if (!deepseekCreds) {
      throw new Error('[DeepSeekExecutor] credentials.deepseek is required');
    }
    if (!deepseekCreds.apiKey) {
      throw new Error('[DeepSeekExecutor] credentials.deepseek.apiKey is required');
    }

    // Initialize DeepSeek client (OpenAI-compatible)
    this.client = new OpenAI({
      apiKey: deepseekCreds.apiKey,
      baseURL: 'https://api.deepseek.com/v1',
      dangerouslyAllowBrowser: deepseekCreds.dangerouslyAllowBrowser
    });

    this.log(`[DeepSeekExecutor] Initialized with model: ${this.model}`);
  }

  /**
   * Invoke DeepSeek API
   * Returns: { message: { role, content, tool_calls }, usage: { input_tokens, output_tokens } }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    // Build request parameters
    const params: any = {
      model: this.model,
      messages: this.#formatMessages(messages),
    };

    // Add all provider-specific parameters from model config
    const providerParams = this.#extractProviderParams();
    Object.assign(params, providerParams);

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map(t => this.#formatTool(t));
    }

    // Add tool_choice if specified
    if (options.tool_choice && options.tool_choice !== 'auto') {
      params.tool_choice = this.#formatToolChoice(options.tool_choice);
    }

    this.log('[DeepSeekExecutor] Invoking:', {
      model: params.model,
      temperature: params.temperature,
      top_p: params.top_p,
      tools: params.tools?.length || 0
    });

    // Call DeepSeek API (OpenAI-compatible)
    const response = await this.client.chat.completions.create(params);

    const choice = response.choices[0];
    const message = choice.message;

    // Format response to match expected structure
    return {
      message: {
        role: message.role,
        content: message.content || '',
        tool_calls: this.#extractToolCalls(message.tool_calls)
      },
      usage: {
        input_tokens: response.usage!.prompt_tokens,
        output_tokens: response.usage!.completion_tokens
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
   * Format messages for DeepSeek API (OpenAI format)
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

      // Handle regular messages
      return {
        role: msg.role,
        content: msg.content
      };
    });
  }

  /**
   * Format tool definition for DeepSeek (OpenAI format)
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
    this.log('[DeepSeekExecutor] Warning: Unrecognized tool format:', JSON.stringify(tool));
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
   * Format tool_choice for DeepSeek (OpenAI format)
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
   * Extract tool calls from DeepSeek response (OpenAI format)
   */
  #extractToolCalls(toolCalls: any[] | undefined): any[] {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    return toolCalls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments)
    }));
  }

  /**
   * Extract provider-specific parameters from model config
   * Excludes displayName, passes rest to DeepSeek API
   */
  #extractProviderParams(): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};
    const { displayName, ...providerParams } = metadata;
    return providerParams;
  }
}

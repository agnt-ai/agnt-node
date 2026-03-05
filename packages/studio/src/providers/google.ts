/**
 * GoogleExecutor - Provider adapter for Google Gemini models
 *
 * Uses native @google/generative-ai SDK
 */

import { GoogleGenerativeAI, Content, Part, FunctionDeclaration, Tool } from '@google/generative-ai';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, Message, InvokeOptions, InvokeResult } from '../types.js';

export default class GoogleExecutor extends BaseExecutor {
  private client: GoogleGenerativeAI;

  constructor(config: BaseExecutorConfig) {
    super(config);

    // Get Google credentials
    const googleCreds = this.credentials.google;
    if (!googleCreds) {
      throw new Error('[GoogleExecutor] credentials.google is required');
    }
    if (!googleCreds.apiKey) {
      throw new Error('[GoogleExecutor] credentials.google.apiKey is required');
    }

    // Browser safety check
    const isBrowser = typeof globalThis !== 'undefined' &&
                      typeof (globalThis as any).window !== 'undefined';
    if (isBrowser && !googleCreds.dangerouslyAllowBrowser) {
      throw new Error(
        '[GoogleExecutor] Using API keys in the browser is unsafe. ' +
        'Set dangerouslyAllowBrowser: true in credentials.google to acknowledge the risk.'
      );
    }

    // Initialize Google client
    this.client = new GoogleGenerativeAI(googleCreds.apiKey);

    this.log(`[GoogleExecutor] Initialized with model: ${this.model}`);
  }

  /**
   * Invoke Google Gemini API
   * Returns: { message: { role, content, tool_calls }, usage: { input_tokens, output_tokens } }
   */
  async invoke(messages: Message[], options: InvokeOptions = {}): Promise<InvokeResult> {
    // Extract provider-specific parameters from model config
    const providerParams = this.#extractProviderParams();

    // Format messages for Gemini (separate system from conversation)
    const { systemInstruction, contents } = this.#formatMessages(messages);

    // Build model config
    const modelConfig: any = {
      ...providerParams
    };

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      const tools = this.#formatTools(options.tools);
      modelConfig.tools = tools;

      // Handle tool_choice
      if (options.tool_choice === 'required') {
        // Gemini doesn't have a direct equivalent to "required"
        // We'll use function calling mode ANY
        modelConfig.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY'
          }
        };
      }
    }

    // Get generative model
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction,
      ...modelConfig
    });

    this.log('[GoogleExecutor] Invoking:', {
      model: this.model,
      temperature: providerParams.temperature,
      topP: providerParams.topP,
      tools: options.tools?.length || 0
    });

    // Call Gemini API
    const result = await model.generateContent({
      contents
    });

    const response = result.response;
    const candidate = response.candidates?.[0];

    if (!candidate) {
      throw new Error('[GoogleExecutor] No candidate in response');
    }

    // Extract content and tool calls
    const textContent = this.#extractTextContent(candidate.content);
    const toolCalls = this.#extractToolCalls(candidate.content);

    // Extract usage
    // Include thoughtsTokenCount (Gemini 2.5+) in output tokens since it's generated reasoning
    const metadata = response.usageMetadata as any;
    const thoughtsTokens = metadata?.thoughtsTokenCount || 0;
    const usage = {
      input_tokens: response.usageMetadata?.promptTokenCount || 0,
      output_tokens: (response.usageMetadata?.candidatesTokenCount || 0) + thoughtsTokens
    };

    // Format response to match expected structure
    return {
      message: {
        role: 'assistant',
        content: textContent,
        tool_calls: toolCalls
      },
      usage
    };
  }

  /**
   * Check if message has tool calls
   */
  hasToolCalls(message: Message): boolean {
    return Boolean(message?.tool_calls && message.tool_calls.length > 0);
  }

  /**
   * Format messages for Gemini API
   * Gemini expects: systemInstruction (string) + contents (Content[])
   * Content = { role: 'user' | 'model', parts: Part[] }
   */
  #formatMessages(messages: Message[]): { systemInstruction?: string; contents: Content[] } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemInstruction = systemMessages.map(m => m.content).join('\n\n');

    const contents: Content[] = [];

    for (const msg of messages) {
      // Skip system messages (handled separately)
      if (msg.role === 'system') {
        continue;
      }

      // Handle tool messages
      if (msg.role === 'tool') {
        // For Google, tool_call_id IS the function name (we set id = name in extractToolCalls)
        const toolName = msg.tool_call_id || msg.name || 'unknown';

        // Tool results go into a 'function' part with a 'functionResponse'
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: toolName,
                response: JSON.parse(msg.content as string)
              }
            }
          ]
        });
        continue;
      }

      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: Part[] = [];

        // Add text content if present
        if (msg.content) {
          parts.push({
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }

        // Add function calls
        for (const toolCall of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.name,
              args: toolCall.args
            }
          });
        }

        contents.push({
          role: 'model',
          parts
        });
        continue;
      }

      // Handle regular user/assistant messages
      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        contents.push({
          role,
          parts: [{ text: msg.content }]
        });
      } else if (Array.isArray(msg.content)) {
        // Handle multimodal content
        const parts = this.#formatMultimodalContent(msg.content);
        contents.push({
          role,
          parts
        });
      }
    }

    return {
      systemInstruction: systemInstruction || undefined,
      contents
    };
  }

  /**
   * Format multimodal content (text + images)
   */
  #formatMultimodalContent(content: any[]): Part[] {
    const parts: Part[] = [];

    for (const item of content) {
      if (item.type === 'text') {
        parts.push({ text: item.text });
      } else if (item.type === 'image_url') {
        // Gemini expects inline data
        const imageUrl = item.image_url?.url || item.image_url;
        if (imageUrl.startsWith('data:')) {
          // Extract base64 data
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2]
              }
            });
          }
        }
      }
    }

    return parts;
  }

  /**
   * Format tools for Gemini
   * Gemini expects: { functionDeclarations: FunctionDeclaration[] }[]
   */
  #formatTools(tools: any[]): Tool[] {
    const functionDeclarations: FunctionDeclaration[] = [];

    for (const tool of tools) {
      let functionDef: any;

      // OpenAI format: { type: "function", function: { name, description, parameters } }
      if (tool.type === 'function' && tool.function) {
        functionDef = {
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: this.#cleanParametersForGemini(tool.function.parameters)
        };
      }
      // Anthropic format: { name, description, input_schema }
      else if (tool.input_schema) {
        functionDef = {
          name: tool.name,
          description: tool.description || '',
          parameters: this.#cleanParametersForGemini(tool.input_schema)
        };
      }
      // Studio format: { name, description, parameters }
      else if (tool.parameters) {
        functionDef = {
          name: tool.name,
          description: tool.description || '',
          parameters: this.#cleanParametersForGemini(tool.parameters)
        };
      }

      if (functionDef) {
        functionDeclarations.push(functionDef);
      }
    }

    return [{ functionDeclarations }];
  }

  /**
   * Clean parameters to only include fields Gemini supports
   * Uses whitelist approach for standard JSON Schema fields
   */
  #cleanParametersForGemini(parameters: any): any {
    if (!parameters || typeof parameters !== 'object') {
      return parameters;
    }

    // Handle arrays
    if (Array.isArray(parameters)) {
      return parameters.map(item => this.#cleanParametersForGemini(item));
    }

    // Whitelist of JSON Schema fields that Gemini supports
    // NOTE: Gemini has strict limits on schema complexity. We only include
    // the most basic fields to avoid "too many states" errors.
    // Excluded: format, minimum, maximum, minLength, maxLength, pattern, minItems, maxItems
    // These create constraints that can exceed Gemini's serving limits.
    const allowedFields = [
      'type',
      'properties',
      'required',
      'description',
      'items',
      'enum',
      'default',
      'nullable',
      'anyOf',
      'allOf',
      'oneOf'
    ];

    const cleaned: any = {};

    for (const key of allowedFields) {
      if (key in parameters) {
        // Recursively clean nested objects (properties, items, etc.)
        if (key === 'properties' && typeof parameters[key] === 'object') {
          cleaned[key] = {};
          for (const propKey in parameters[key]) {
            const cleanedProp = this.#cleanParametersForGemini(parameters[key][propKey]);
            // Only include property if it has at least one field after cleaning
            if (cleanedProp && typeof cleanedProp === 'object' && Object.keys(cleanedProp).length > 0) {
              cleaned[key][propKey] = cleanedProp;
            }
          }
        } else if (key === 'items' && typeof parameters[key] === 'object') {
          cleaned[key] = this.#cleanParametersForGemini(parameters[key]);
        } else if ((key === 'anyOf' || key === 'allOf' || key === 'oneOf') && Array.isArray(parameters[key])) {
          cleaned[key] = parameters[key].map((item: any) => this.#cleanParametersForGemini(item));
        } else {
          cleaned[key] = parameters[key];
        }
      }
    }

    // Filter the 'required' array to only include properties that exist in cleaned.properties
    // This prevents Gemini errors when required references non-existent properties
    if (cleaned.required && Array.isArray(cleaned.required) && cleaned.properties) {
      cleaned.required = cleaned.required.filter((propName: string) =>
        propName in cleaned.properties
      );

      // Remove required array if it's empty
      if (cleaned.required.length === 0) {
        delete cleaned.required;
      }
    }

    return cleaned;
  }

  /**
   * Extract text content from Gemini response
   */
  #extractTextContent(content: Content): string {
    if (!content.parts || content.parts.length === 0) {
      return '';
    }

    const textParts = content.parts
      .filter(part => 'text' in part)
      .map(part => (part as any).text);

    return textParts.join('');
  }

  /**
   * Extract tool calls from Gemini response
   */
  #extractToolCalls(content: Content): any[] {
    if (!content.parts || content.parts.length === 0) {
      return [];
    }

    const toolCalls: any[] = [];

    for (const part of content.parts) {
      if ('functionCall' in part && part.functionCall) {
        toolCalls.push({
          id: part.functionCall.name, // Use function name as ID since Google doesn't provide IDs
          name: part.functionCall.name,
          args: part.functionCall.args || {}
        });
      }
    }

    return toolCalls;
  }

  /**
   * Extract provider-specific parameters from model config
   */
  #extractProviderParams(): Record<string, any> {
    const metadata = (this.primaryModelConfig as any).metadata || {};
    const { displayName, ...providerParams } = metadata;
    return providerParams;
  }
}

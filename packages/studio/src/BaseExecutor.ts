/**
 * BaseExecutor — V2 PromptManifest native executor
 *
 * Operates directly on the v2 manifest spec:
 * - Renders files/blocks from spec.files[] (no pre-compiled system/user strings)
 * - Evaluates conditions on files, blocks, tools, and models at runtime
 * - Respects enableToolCalls: false (skips tool loop, returns raw LLM text)
 * - Routes models via routingStrategy (fallback | random | conditional)
 */

import type {
  BaseExecutorConfig,
  PromptManifestV2,
  V2ModelConfig,
  V2VariableDef,
  PromptBlock,
  Message,
  ToolCall,
  ToolResult,
  ToolDefinition,
  InvokeOptions,
  InvokeResult,
  ExecutionResult,
  Usage,
  ToolRouter,
  ToolCallCallback,
  TracingConfig,
  ModelPricing
} from './types.js';
import { evaluateCondition } from './conditions.js';
import { sendTrace } from './tracing.js';
import { SYSTEM_TOOL_NAMES } from './systemTools.js';
import { normalizeToolResult } from './openclawAdapter.js';
import type { HookRegistry } from './hooks.js';

export default class BaseExecutor {
  protected manifest: PromptManifestV2;
  protected variables: Record<string, any>;
  protected toolRouter: ToolRouter;
  protected credentials: any;
  protected log: (message: string, ...args: any[]) => void;
  protected debug: (message: string, ...args: any[]) => void;
  protected messages: Message[];
  protected onToolCall?: ToolCallCallback;
  protected cancelled: boolean;
  protected toolErrorCount: Record<string, number>;
  protected forceNextTool?: string;
  protected executorFactory?: (config: BaseExecutorConfig) => Promise<any>;
  protected instructions: string;
  protected primaryModelConfig: V2ModelConfig & { name: string };
  protected provider: string;
  protected model: string;
  protected allToolDefs: ToolDefinition[];
  protected tracing?: TracingConfig;
  protected files?: Array<any>;
  protected maxMessages: number;
  protected _initialMessageCount: number = 0;
  protected modelPricing?: ModelPricing;
  protected initialToolChoice: 'auto' | 'required' | 'none' | string;
  protected hooks?: HookRegistry;

  constructor({
    manifest,
    variables = {},
    toolRouter,
    credentials,
    messages = [],
    onToolCall,
    hooks,
    log = console.log,
    logLevel = 'info',
    tracing,
    files,
    maxMessages = 50,
    initialToolChoice,
    executorFactory,
    modelPricing
  }: BaseExecutorConfig) {
    this.manifest = manifest;
    if (!this.manifest) throw new Error('[BaseExecutor] manifest is required');

    this.validateManifest();

    this.variables = variables;
    this.toolRouter = toolRouter || {};
    this.credentials = credentials || {};
    this.log = logLevel === 'silent' ? () => {} : log;
    this.debug = logLevel === 'debug' ? log : () => {};
    this.files = files;
    this.maxMessages = maxMessages;
    this.messages = messages;
    // maxMessages limits only NEW tool-turn messages, not pre-existing conversation history.
    this._initialMessageCount = messages.length;
    this.onToolCall = onToolCall;
    this.cancelled = false;
    this.toolErrorCount = {};
    this.forceNextTool = undefined;
    this.tracing = tracing;
    this.hooks = hooks;
    this.executorFactory = executorFactory;
    if (modelPricing) this.modelPricing = modelPricing;

    // Select primary model from spec (respects routing strategy + conditions)
    const primaryModel = this.selectPrimaryModel();
    // Normalize: expose .name for provider adapter compatibility
    this.primaryModelConfig = { ...primaryModel, name: primaryModel.model };
    this.provider = primaryModel.provider;
    this.model = primaryModel.model;

    // Determine initialToolChoice
    const enableToolCalls = this.manifest.spec.enableToolCalls !== false;
    this.initialToolChoice = initialToolChoice ?? (enableToolCalls ? 'required' : 'none');

    // Build active tool definitions (filtered by condition)
    this.allToolDefs = this.buildToolDefinitions();

    // Build system instructions from spec.files[section=system]
    this.instructions = this.buildInstructions();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Manifest validation
  // ─────────────────────────────────────────────────────────────────────────────

  protected validateManifest(): void {
    if (this.manifest.kind !== 'PromptManifest') {
      throw new Error('[BaseExecutor] manifest.kind must be "PromptManifest"');
    }
    if (this.manifest.apiVersion !== 'v2') {
      throw new Error('[BaseExecutor] manifest.apiVersion must be "v2"');
    }
    const spec = this.manifest.spec;
    if (!spec) throw new Error('[BaseExecutor] manifest.spec is required');
    if (!spec.models || spec.models.length === 0) {
      throw new Error('[BaseExecutor] manifest.spec.models is required and must not be empty');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Model selection
  // ─────────────────────────────────────────────────────────────────────────────

  protected selectPrimaryModel(): V2ModelConfig {
    const models = this.manifest.spec.models;
    const strategy = this.manifest.spec.routingStrategy ?? 'fallback';

    if (strategy === 'random') {
      const idx = Math.floor(Math.random() * models.length);
      return models[idx];
    }

    if (strategy === 'conditional' || strategy === 'conditional_with_fallback') {
      const passing = models.filter(m => evaluateCondition(m.condition, this.variables));
      if (passing.length > 0) return passing[0];
      if (strategy === 'conditional_with_fallback') {
        // Fall through to fallback logic below
      } else {
        throw new Error('[BaseExecutor] No model condition passed and strategy is "conditional"');
      }
    }

    // fallback: pick lowest fallbackOrder, then array order
    const sorted = [...models].sort(
      (a, b) => (a.fallbackOrder ?? 0) - (b.fallbackOrder ?? 0)
    );
    return sorted[0];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool definitions
  // ─────────────────────────────────────────────────────────────────────────────

  protected buildToolDefinitions(): ToolDefinition[] {
    if (this.manifest.spec.enableToolCalls === false) return [];

    const tools = this.manifest.spec.tools ?? [];
    return tools
      .filter(t => evaluateCondition(t.condition, this.variables))
      .map(t => this.processToolDefinition({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} }
        }
      }));
  }

  /**
   * Reorder tool schema properties so reasoning fields appear first.
   * Ensures LLM generates reason before action when strict: true.
   */
  protected processToolDefinition(tool: ToolDefinition): ToolDefinition {
    const processed = JSON.parse(JSON.stringify(tool));
    if (processed.function?.parameters) {
      processed.function.parameters = this.reorderReasoningFields(processed.function.parameters);
    }
    return processed;
  }

  protected reorderReasoningFields(schema: any): any {
    if (!schema?.properties) return schema;
    const processed = { ...schema };
    const reasoningField = ['reason', 'reasoning'].find(f => f in schema.properties);
    if (reasoningField) {
      const { [reasoningField]: rf, ...rest } = processed.properties;
      processed.properties = { [reasoningField]: rf, ...rest };
      if (Array.isArray(processed.required) && processed.required.includes(reasoningField)) {
        processed.required = [
          reasoningField,
          ...processed.required.filter((f: string) => f !== reasoningField)
        ];
      }
    }
    return processed;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Block rendering
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Render all files for a given section into a single string.
   */
  protected renderSection(section: 'system' | 'messages'): string {
    const files = (this.manifest.spec.files ?? [])
      .filter(f => f.section === section)
      .sort((a, b) => a.order - b.order);

    const parts: string[] = [];
    for (const file of files) {
      if (!evaluateCondition(file.condition, this.variables)) continue;
      const content = this.renderBlocks(file.blocks ?? []);
      if (content) parts.push(content);
    }
    return parts.join('\n\n');
  }

  protected renderBlocks(blocks: PromptBlock[]): string {
    const sorted = [...blocks].sort((a, b) => a.order - b.order);
    const parts: string[] = [];
    for (const block of sorted) {
      if (!evaluateCondition(block.condition, this.variables)) continue;
      const rendered = this.renderBlock(block);
      if (rendered) parts.push(rendered);
    }
    return parts.join('\n\n');
  }

  protected renderBlock(block: PromptBlock): string {
    switch (block.type) {
      case 'text':
        return this.populateTemplate(block.content ?? '', this.variables);

      case 'heading': {
        const level = Math.min(Math.max(block.headingLevel ?? 2, 1), 6);
        return `${'#'.repeat(level)} ${block.content ?? ''}`;
      }

      case 'divider':
        return '---';

      case 'variable': {
        const val = this.variables[block.variableKey ?? ''];
        return val !== undefined && val !== null ? String(val) : '';
      }

      case 'component_ref': {
        const comp = this.manifest.resolvedDependencies?.components?.find(
          c => c.name === block.componentName
        );
        return comp?.content ? this.populateTemplate(comp.content, this.variables) : '';
      }

      case 'assistant_ref': {
        const assistant = this.manifest.resolvedDependencies?.assistants?.find(
          a => a.name === block.assistantName
        );
        if (!assistant) return '';
        if (assistant.blocks) return this.renderBlocks(assistant.blocks as PromptBlock[]);
        return assistant.content ? this.populateTemplate(assistant.content, this.variables) : '';
      }

      case 'skill_ref': {
        const skill = this.manifest.resolvedDependencies?.skills?.find(
          s => s.name === block.skillName
        );
        if (!skill) return '';
        if (block.scenarioName) {
          const scenario = skill.scenarios?.find(sc => sc.name === block.scenarioName);
          return scenario?.content ? this.populateTemplate(scenario.content, this.variables) : '';
        }
        return skill.content ? this.populateTemplate(skill.content, this.variables) : '';
      }

      default:
        return '';
    }
  }

  protected buildInstructions(): string {
    return this.renderSection('system');
  }

  protected populateTemplate(template: string, variables: Record<string, any>): string {
    if (!template) return '';
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
      if (key.startsWith('component.')) {
        const compName = key.slice('component.'.length);
        const comp = this.manifest.resolvedDependencies?.components?.find(c => c.name === compName);
        return comp?.content ? this.populateTemplate(comp.content, variables) : match;
      }
      return variables[key] !== undefined ? String(variables[key]) : match;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool choice normalization
  // ─────────────────────────────────────────────────────────────────────────────

  protected normalizeToolChoice(toolChoice: 'auto' | 'required' | 'none' | string): any {
    if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') {
      return toolChoice;
    }
    return { type: 'function', function: { name: toolChoice } };
  }

  cancel(): boolean {
    this.cancelled = true;
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Variable validation
  // ─────────────────────────────────────────────────────────────────────────────

  protected validateVariables(): void {
    const schema = this.manifest.spec.variables ?? [];
    for (const varDef of schema) {
      if (!varDef.required) continue;
      // Skip if the variable's own condition doesn't pass
      if (!evaluateCondition(varDef.condition, this.variables)) continue;
      if (this.variables[varDef.key] === undefined) {
        throw new Error(`[BaseExecutor] Required variable missing: ${varDef.key}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message building
  // ─────────────────────────────────────────────────────────────────────────────

  protected buildInitialMessages(): Message[] {
    const messages: Message[] = [];

    messages.push({ role: 'system', content: this.instructions });

    const userContent = this.renderSection('messages');
    let finalUserContent: string | any[];
    if (this.files && this.files.length > 0) {
      finalUserContent = [{ type: 'text', text: userContent }, ...this.files];
    } else {
      finalUserContent = userContent;
    }

    messages.push({ role: 'user', content: finalUserContent });
    return messages;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pricing
  // ─────────────────────────────────────────────────────────────────────────────

  // Sum all input token variants from a usage object.
  // Anthropic splits into input_tokens (uncached), cache_creation_input_tokens,
  // and cache_read_input_tokens. All three must be counted.
  protected sumInputTokens(usage: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined | null): number {
    if (!usage) return 0;
    return (usage.input_tokens || 0) +
           (usage.cache_creation_input_tokens || 0) +
           (usage.cache_read_input_tokens || 0);
  }

  // Calculate cost in USD using per-model rates from the pricing catalog.
  // When a raw usage object is passed, applies the correct rate for each
  // token type (regular, cache creation, cache read).
  protected calculateCost(
    inputTokensOrUsage: number | { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
    outputTokens: number
  ): number {
    const p = this.modelPricing;
    const inRate      = p?.inputTokensPer1M          ?? 3;
    const outRate     = p?.outputTokensPer1M         ?? 15;
    // Fall back to Anthropic standard multipliers if catalog rates not seeded yet
    const createRate  = p?.cacheCreationTokensPer1M  ?? inRate * 1.25;
    const readRate    = p?.cacheReadTokensPer1M      ?? inRate * 0.10;

    let costUSD = (outputTokens / 1_000_000) * outRate;

    if (typeof inputTokensOrUsage === 'number') {
      costUSD += (inputTokensOrUsage / 1_000_000) * inRate;
    } else {
      const u = inputTokensOrUsage;
      costUSD += ((u.input_tokens                 || 0) / 1_000_000) * inRate;
      costUSD += ((u.cache_creation_input_tokens  || 0) / 1_000_000) * createRate;
      costUSD += ((u.cache_read_input_tokens      || 0) / 1_000_000) * readRate;
    }
    return costUSD;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main execution
  // ─────────────────────────────────────────────────────────────────────────────

  async execute(): Promise<ExecutionResult> {
    try {
      // Fire before_agent_start hook
      if (this.hooks?.has('before_agent_start')) {
        await this.hooks.fire('before_agent_start', {
          manifest: this.manifest,
          variables: this.variables,
        });
      }

      this.validateVariables();

      // Fire before_prompt_build hook — can prepend/append to system prompt
      if (this.hooks?.has('before_prompt_build')) {
        const hookResult = await this.hooks.fire('before_prompt_build', {
          instructions: this.instructions,
          variables: this.variables,
        });
        if (hookResult) {
          if (hookResult.prepend) this.instructions = hookResult.prepend + '\n\n' + this.instructions;
          if (hookResult.append) this.instructions = this.instructions + '\n\n' + hookResult.append;
          if (hookResult.instructions) this.instructions = hookResult.instructions;
        }
      }

      if (this.messages.length === 0) {
        this.messages = this.buildInitialMessages();
      }

      const enableToolCalls = this.manifest.spec.enableToolCalls !== false;

      const toolChoice = this.normalizeToolChoice(this.initialToolChoice);

      const turnStart = Date.now();
      const result = await this.invoke(this.messages, {
        tools: enableToolCalls ? this.allToolDefs : [],
        tool_choice: enableToolCalls ? toolChoice : 'none'
      });
      const turnDuration = Date.now() - turnStart;

      const usage: Usage = {
        inputTokens:          result.usage?.input_tokens                || 0,
        cacheCreationTokens:  result.usage?.cache_creation_input_tokens || 0,
        cacheReadTokens:      result.usage?.cache_read_input_tokens     || 0,
        outputTokens:         result.usage?.output_tokens               || 0,
        totalCostUSD:         0,
      };
      usage.totalCostUSD = this.calculateCost(result.usage ?? 0, usage.outputTokens);

      this.messages.push(result.message);
      await this.sendTurnTrace(result.usage || { input_tokens: 0, output_tokens: 0 }, turnDuration, usage.totalCostUSD);

      // No tools → return message content directly
      if (!enableToolCalls || this.allToolDefs.length === 0) {
        const content = result.message.content;
        return {
          ok: !this.cancelled,
          usage,
          result: typeof content === 'string' ? content : content,
          messages: this.messages
        };
      }

      // Tool loop
      let output: any;
      const hasToolRouter = Object.keys(this.toolRouter).length > 0;
      if (hasToolRouter) {
        output = await this.runToolLoop(result.message, usage);
        // Handle pause signal from runToolLoop
        if (output && typeof output === 'object' && output.__paused) {
          return {
            ok: true,
            paused: true,
            pendingToolCall: output.pendingToolCall,
            usage,
            result: null,
            messages: this.messages
          };
        }
      } else if (result.message.tool_calls && result.message.tool_calls.length > 0) {
        output = result.message.tool_calls[0].args;
      } else {
        output = result.message.content;
      }

      // Fire agent_end hook
      if (this.hooks?.has('agent_end')) {
        await this.hooks.fire('agent_end', { result: output, usage, cancelled: this.cancelled });
      }

      return { ok: !this.cancelled, usage, result: output, messages: this.messages };

    } catch (error: any) {
      return {
        ok: false,
        usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalCostUSD: 0 },
        result: null,
        messages: this.messages,
        error: error.message
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool loop
  // ─────────────────────────────────────────────────────────────────────────────

  protected async runToolLoop(message: Message, usage: Usage): Promise<any> {
    const terminatingTools = ['finish_agent_run', 'output'];

    while (this.hasToolCalls(message)) {
      if (this.cancelled) break;

      if ((this.messages.length - this._initialMessageCount) >= this.maxMessages) {
        throw new Error(
          `[BaseExecutor] Message stack exceeded ${this.maxMessages} new messages. ` +
          'Agent must call finish_agent_run to complete.'
        );
      }

      // Tag each tool call with source before routing
      const taggedToolCalls = message.tool_calls!.map(tc => ({
        ...tc,
        source: (SYSTEM_TOOL_NAMES.has(tc.name) ? 'system' : 'custom') as 'system' | 'custom'
      }));

      // Check for custom tools not in the router — these trigger pause
      if (this.onToolCall) {
        for (const tc of taggedToolCalls) {
          if (tc.source === 'custom' && !this.toolRouter[tc.name] && !terminatingTools.includes(tc.name)) {
            this.log(`[BaseExecutor] Custom tool '${tc.name}' not in router — pausing execution`);
            const cbResult = await this.onToolCall({ toolCall: tc, toolResponse: undefined });
            if (cbResult?.pause) {
              return { __paused: true, pendingToolCall: tc };
            }
          }
        }
      }

      const toolResults = await this.handleToolCalls(taggedToolCalls);

      this.forceNextTool = toolResults.find(r => r.forceNextTool)?.forceNextTool;

      for (const r of toolResults) {
        this.messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: JSON.stringify(r.content) });
      }

      if (this.onToolCall) {
        for (let i = 0; i < taggedToolCalls.length; i++) {
          const tc = taggedToolCalls[i];
          if (terminatingTools.includes(tc.name)) continue;
          if (tc.source === 'custom' && !this.toolRouter[tc.name]) continue; // already handled above
          const cbResult = await this.onToolCall({ toolCall: tc, toolResponse: toolResults[i]?.content });
          if (cbResult?.abort) { this.cancelled = true; break; }
        }
      }

      if (this.cancelled) break;

      const termCall = taggedToolCalls.find(c => terminatingTools.includes(c.name));
      if (termCall) {
        const termResult = toolResults.find(r => r.tool_call_id === termCall.id);
        if (termResult && (termResult.content.completed === false || termResult.content.error)) {
          this.log('[BaseExecutor] Terminating tool rejected, continuing');
        } else {
          return termCall.args;
        }
      }

      const toolChoiceStr = this.forceNextTool ?? 'required';
      const toolChoice = this.normalizeToolChoice(toolChoiceStr);

      const turnStart = Date.now();
      const result = await this.invoke(this.messages, { tools: this.allToolDefs, tool_choice: toolChoice });
      const turnDuration = Date.now() - turnStart;

      usage.inputTokens         += result.usage?.input_tokens                || 0;
      usage.cacheCreationTokens += result.usage?.cache_creation_input_tokens || 0;
      usage.cacheReadTokens     += result.usage?.cache_read_input_tokens     || 0;
      usage.outputTokens        += result.usage?.output_tokens               || 0;
      // Recalculate with the full per-type breakdown so cache rates are applied correctly
      usage.totalCostUSD = this.calculateCost({
        input_tokens:                usage.inputTokens,
        cache_creation_input_tokens: usage.cacheCreationTokens,
        cache_read_input_tokens:     usage.cacheReadTokens,
      }, usage.outputTokens);

      message = result.message;
      this.messages.push(message);

      const turnCost = this.calculateCost(result.usage ?? 0, result.usage?.output_tokens || 0);
      await this.sendTurnTrace(result.usage || { input_tokens: 0, output_tokens: 0 }, turnDuration, turnCost);
    }

    if (this.cancelled) return { ok: false, status: 'cancelled' };
    throw new Error('[BaseExecutor] Agent ended without calling terminating tool');
  }

  protected async handleToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      this.log(`[BaseExecutor] Executing tool: ${tc.name}`);
      let toolResult: any;

      // Fire before_tool_call hook — can block or modify args
      if (this.hooks?.has('before_tool_call')) {
        const hookResult = await this.hooks.fire('before_tool_call', {
          name: tc.name,
          args: tc.args,
          source: tc.source,
        });
        if (hookResult?.block) {
          toolResult = { completed: false, error: true, message: hookResult.reason ?? 'Blocked by hook' };
          results.push({ tool_call_id: tc.id, content: toolResult });
          continue;
        }
        if (hookResult?.args) {
          tc.args = hookResult.args;
        }
      }

      if (tc.name === 'finish_agent_run') {
        const handler = this.toolRouter[tc.name];
        if (handler) {
          try {
            toolResult = await handler.execute(tc.args);
          } catch (err: any) {
            toolResult = { completed: false, error: true, message: err.message };
          }
        } else {
          toolResult = tc.args;
        }
      } else {
        const handler = this.toolRouter[tc.name];
        if (!handler) {
          toolResult = { completed: false, error: true, message: `Tool '${tc.name}' not found` };
        } else {
          try {
            toolResult = await handler.execute(tc.args);
            // Normalize OpenClaw-format results ({ content: [{type, text}] }) to AGNT format
            toolResult = normalizeToolResult(toolResult);
            this.toolErrorCount[tc.name] = 0;
          } catch (err: any) {
            this.toolErrorCount[tc.name] = (this.toolErrorCount[tc.name] || 0) + 1;
            if (this.toolErrorCount[tc.name] >= 3) throw err;
            toolResult = { completed: false, error: true, message: 'Tool error. Please try a different approach.' };
          }
        }
      }

      // Fire after_tool_call hook (observability)
      if (this.hooks?.has('after_tool_call')) {
        await this.hooks.fire('after_tool_call', {
          name: tc.name,
          args: tc.args,
          result: toolResult,
          source: tc.source,
        });
      }

      results.push({ tool_call_id: tc.id, content: toolResult, forceNextTool: toolResult?.forceNextTool });
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tracing
  // ─────────────────────────────────────────────────────────────────────────────

  protected async sendTurnTrace(
    turnUsage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null | undefined,
    turnDuration: number,
    cost: number
  ): Promise<void> {
    if (!this.tracing && !this.hooks?.has('llm_output')) return;

    const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant');
    const lastIdx = lastAssistant ? this.messages.lastIndexOf(lastAssistant) : -1;
    const messagesWithoutOutput = lastIdx >= 0
      ? [...this.messages.slice(0, lastIdx), ...this.messages.slice(lastIdx + 1)]
      : this.messages;

    const totalInput  = this.sumInputTokens(turnUsage);
    const totalOutput = turnUsage?.output_tokens || 0;

    const turnPayload = {
      promptName: this.manifest.metadata.name,
      manifest: this.manifest,
      etag: this.manifest.metadata.etag || null,
      variables: this.variables,
      messages: messagesWithoutOutput.slice(2),
      output: lastAssistant || null,
      inputTokens:  totalInput,
      outputTokens: totalOutput,
      totalTokens:  totalInput + totalOutput,
      // Cache breakdown for observability
      cacheCreationTokens: turnUsage?.cache_creation_input_tokens || 0,
      cacheReadTokens:     turnUsage?.cache_read_input_tokens     || 0,
      cost,
      duration: turnDuration,
      model: { provider: this.provider, name: this.model, metadata: this.primaryModelConfig.metadata || {} },
      status: 'completed',
      metadata: { turnNumber: this.messages.filter(m => m.role === 'assistant').length },
      tags: this.tracing?.tags || []
    };

    if (this.tracing) {
      await sendTrace(this.tracing, turnPayload, this.log);
    }

    if (this.hooks?.has('llm_output')) {
      await this.hooks.fire('llm_output', turnPayload);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Abstract — implemented by provider adapters
  // ─────────────────────────────────────────────────────────────────────────────

  async invoke(_messages: Message[], _options: InvokeOptions): Promise<InvokeResult> {
    throw new Error('invoke() must be implemented by provider adapter');
  }

  hasToolCalls(_message: Message): boolean {
    throw new Error('hasToolCalls() must be implemented by provider adapter');
  }
}

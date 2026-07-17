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
import { deepWellForm } from './wellFormed.js';
import { StreamAbortError } from './providers/streaming.js';
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
  /** Per-run abort signal. cancel() aborts it so an in-flight token stream stops
   *  cleanly (the provider adapters thread it into their streaming call). */
  protected abortController: AbortController;
  protected toolErrorCount: Record<string, number>;
  protected forceNextTool?: string;
  protected executorFactory?: (config: BaseExecutorConfig) => Promise<any>;
  /** The config this executor was built from — reused to spawn cross-provider fallback executors. */
  protected baseConfig: BaseExecutorConfig;
  protected instructions: string;
  protected primaryModelConfig: V2ModelConfig & { name: string };
  protected provider: string;
  protected model: string;
  /**
   * Snapshot of the originally-selected primary model, captured ONCE at
   * construction time (right after selectPrimaryModel()) and never mutated
   * again. invokeWithFallback() resets primaryModelConfig/provider/model from
   * this snapshot at the start of every turn — see invokeWithFallback() for
   * why this must stay a fixed snapshot rather than be re-derived by calling
   * selectPrimaryModel() again mid-run (that would re-roll a 'random'
   * strategy or re-evaluate a 'conditional' strategy against variables that
   * may have drifted since construction — the primary model for a given
   * executor instance must stay fixed for that instance's lifetime).
   */
  protected initialPrimaryModelConfig: V2ModelConfig & { name: string };
  protected allToolDefs: ToolDefinition[];
  protected tracing?: TracingConfig;
  protected files?: Array<any>;
  protected maxMessages: number;
  protected _initialMessageCount: number = 0;
  protected modelPricing?: ModelPricing;
  protected initialToolChoice: 'auto' | 'required' | 'none' | string;
  protected disableCache: boolean;
  protected hooks?: HookRegistry;

  constructor(config: BaseExecutorConfig) {
    const {
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
      modelPricing,
      disableCache = false,
    } = config;
    this.baseConfig = config;
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
    this.abortController = new AbortController();
    this.toolErrorCount = {};
    this.forceNextTool = undefined;
    this.tracing = tracing;
    this.hooks = hooks;
    this.executorFactory = executorFactory;
    if (modelPricing) this.modelPricing = modelPricing;
    this.disableCache = disableCache;

    // Select primary model from spec (respects routing strategy + conditions)
    const primaryModel = this.selectPrimaryModel();
    // Normalize: expose .name for provider adapter compatibility
    this.primaryModelConfig = { ...primaryModel, name: primaryModel.model };
    this.provider = primaryModel.provider;
    this.model = primaryModel.model;
    // Fixed for the lifetime of this executor instance — see field doc above.
    this.initialPrimaryModelConfig = { ...this.primaryModelConfig };

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
    // Abort any in-flight token stream immediately rather than waiting for the
    // between-turns cancelled check — a long streamed response could otherwise
    // keep running for the full backstop after a stop.
    this.abortController.abort();
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Model fallback
  // ─────────────────────────────────────────────────────────────────────────────

  // Provider adapters call this to classify a mid-stream failure for retry.
  protected isRetryableError(error: any): boolean {
    // A streamed attempt that exhausted its in-place retries on an IDLE stall is
    // a model-health signal — fall back to the next model. A backstop (a stream
    // that dribbled to the absolute ceiling) or an external abort (caller stop)
    // is terminal: don't waste another model on it.
    if (error instanceof StreamAbortError) return error.reason === 'idle';
    // HTTP status codes from Anthropic, OpenAI, Google, etc.
    const status = typeof error?.status === 'number' ? error.status : undefined;
    if (status !== undefined) {
      // Any 5xx except 501 is a transient server-side fault — 500 internal,
      // 502 bad gateway, 503 unavailable, 504 gateway timeout, 529 Anthropic
      // overloaded, and the 520–524 family some CDNs/proxies emit. 501 Not
      // Implemented is permanent (endpoint/feature missing) — retrying it burns
      // quota and masks the root cause.
      if (status >= 500 && status !== 501) return true;
      if (status === 429) return true; // Rate limited — fall back rather than wait
      if (status === 408) return true; // Request timeout
    }
    // Anthropic SDK typed errors
    const retryableNames = [
      'InternalServerError', 'OverloadedError', 'RateLimitError',
      'APIConnectionError', 'APIConnectionTimeoutError',
    ];
    if (retryableNames.includes(error?.constructor?.name)) return true;
    // Node.js network error codes
    const networkCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
    if (networkCodes.includes(error?.code)) return true;
    // Pattern fallback for providers that don't use typed errors
    if (/overloaded|rate.?limit|server.?error|internal.?error|timed?.out|connection.?reset/i.test(
      error?.message ?? ''
    )) return true;
    return false;
  }

  /**
   * Invoke with automatic model fallback.
   *
   * Tries models in fallbackOrder. On a retryable error (5xx, overloaded, rate
   * limit, network drop) it switches to the next model in the list and retries.
   * Same-provider fallback (e.g. claude-opus → claude-sonnet) reuses this client
   * by pointing this.model at the next model. Cross-provider fallback (e.g.
   * claude-opus → gpt-5) can't reuse the client — it spawns a provider-correct
   * executor via the injected executorFactory and delegates the single invoke.
   * Non-retryable errors (4xx auth/validation) are re-thrown immediately.
   *
   * Known limitation: this.modelPricing is resolved once, for the primary
   * model, before any fallback happens (see AgntExecutor.resolveModelPricing).
   * A turn served by a fallback model — same-provider or cross-provider —
   * still costs using the primary model's rate card. provider/model naming is
   * corrected on fallback (see below); pricing is not. Pre-existing, not
   * introduced here — flagging so it isn't mistaken for fixed.
   */
  protected async invokeWithFallback(messages: Message[], options: InvokeOptions): Promise<InvokeResult> {
    // Well-form the outbound payload before it can reach any provider client.
    // A single unpaired UTF-16 surrogate (half an emoji left by upstream string
    // truncation) makes the JSON request body invalid, and every provider
    // rejects it with a NON-RETRYABLE 400 — which defeats model fallback below,
    // trips the crash path into panic-recovery, and re-poisons any retry task
    // that rebuilds the same context. Doing it here, at the shared dispatch
    // boundary, covers same- and cross-provider invokes in one place. Strings
    // are almost always already well-formed, so this is a scan with no clone.
    messages = deepWellForm(messages);
    if (options.tools) options = { ...options, tools: deepWellForm(options.tools) };

    // Reset to the originally-selected primary model at the start of every
    // turn. This executor instance is reused across a multi-turn tool loop —
    // a PRIOR turn may have fallen back to a different provider/model and
    // mutated primaryModelConfig/provider/model (see the crossProvider and
    // same-provider branches below). Without this reset, the i === 0
    // iteration below would call this.invoke() with `this` still pointed at
    // whatever provider/model the previous turn's fallback landed on — e.g.
    // an AnthropicExecutor (hardcoded to Anthropic's SDK) with this.model
    // still set to "gpt-5.4" from a prior cross-provider fallback, producing
    // a literal Anthropic request for a model it doesn't serve (404
    // not_found_error). Every turn must start clean from the manifest's
    // original primary, regardless of what the previous turn fell back to.
    this.primaryModelConfig = { ...this.initialPrimaryModelConfig };
    this.provider = this.initialPrimaryModelConfig.provider;
    this.model = this.initialPrimaryModelConfig.model;

    const orderedModels = [...this.manifest.spec.models].sort(
      (a, b) => (a.fallbackOrder ?? 0) - (b.fallbackOrder ?? 0)
    );

    let lastError: any;

    for (let i = 0; i < orderedModels.length; i++) {
      const modelConfig = orderedModels[i];
      // Only treat as cross-provider on a genuine fallback hop. At i=0 we always
      // use the already-selected primary, so non-fallback routing strategies
      // (random/conditional) keep their existing behavior.
      const crossProvider = i > 0 && modelConfig.provider !== this.provider;

      if (i > 0) {
        this.log(`[BaseExecutor] ${orderedModels[i - 1].model} failed — falling back to ${modelConfig.provider}/${modelConfig.model}`);
      }

      try {
        if (crossProvider) {
          // Different provider than the current client — swapping this.model in
          // place would send the request through the wrong SDK. Build a
          // provider-correct executor from this executor's own config (manifest
          // narrowed to just this model) and delegate the single invoke.
          if (!this.executorFactory) {
            this.log(`[BaseExecutor] No executorFactory — cannot fall back to ${modelConfig.provider}/${modelConfig.model}, skipping`);
            continue;
          }
          const sub = await this.executorFactory({
            ...this.baseConfig,
            manifest: { ...this.manifest, spec: { ...this.manifest.spec, models: [modelConfig] } },
            messages,
          });
          const subResult = await sub.invoke(messages, options);
          // Sync provider/model state onto `this` so downstream attribution
          // (sendTurnTrace's model field, calculateCost's pricing lookup) reflects
          // the model that actually served this turn, not the original primary —
          // mirrors the same-provider branch below. Only after a successful
          // invoke: on failure we fall through to the catch and keep looping,
          // and must not have mutated state for a hop that didn't pan out.
          this.primaryModelConfig = { ...modelConfig, name: modelConfig.model };
          this.provider = modelConfig.provider;
          this.model = modelConfig.model;
          return subResult;
        }

        if (i > 0) {
          // Same provider — reuse this client, just point it at the next model.
          this.primaryModelConfig = { ...modelConfig, name: modelConfig.model };
          this.provider = modelConfig.provider;
          this.model = modelConfig.model;
        }
        return await this.invoke(messages, options);
      } catch (error: any) {
        if (this.isRetryableError(error)) {
          this.log(`[BaseExecutor] ${modelConfig.model} retryable error: ${error.message}`);
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error('[BaseExecutor] All models in the fallback list failed');
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
  //
  // Provider-agnostic, model-driven: cost is data, not branching. The four-term
  // formula is identical for every provider and model. Cache rates come straight
  // from the catalog; a null/undefined cache rate contributes 0 — that is how
  // "this provider doesn't charge for cache creation" is expressed (e.g. OpenAI
  // and Google have no cache-creation rate). Never special-case a provider here.
  //
  //   cost = input        /1e6 * inputTokensPer1M
  //        + output       /1e6 * outputTokensPer1M
  //        + cacheRead    /1e6 * (cacheReadTokensPer1M     ?? 0)
  //        + cacheCreation/1e6 * (cacheCreationTokensPer1M ?? 0)
  //
  // Accepts either a raw provider usage object (disjoint buckets) or, for the
  // simple no-cache call sites, plain input/output token counts.
  protected calculateCost(
    inputTokensOrUsage: number | { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
    outputTokens: number
  ): number {
    const p = this.modelPricing;
    const inRate      = p?.inputTokensPer1M          ?? 3;
    const outRate     = p?.outputTokensPer1M         ?? 15;
    // A null/undefined cache rate means this provider/model doesn't bill that
    // bucket — it contributes 0. No provider-specific multiplier fallback.
    const createRate  = p?.cacheCreationTokensPer1M  ?? 0;
    const readRate    = p?.cacheReadTokensPer1M      ?? 0;

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
      const result = await this.invokeWithFallback(this.messages, {
        tools: enableToolCalls ? this.allToolDefs : [],
        tool_choice: enableToolCalls ? toolChoice : 'none',
        disableCache: this.disableCache,
        signal: this.abortController.signal,
      });
      const turnDuration = Date.now() - turnStart;

      const usage: Usage = {
        inputTokens:          this.sumInputTokens(result.usage),         // total for display/Trace
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
        // RR release_after_read: if the originating call asked for it, tag the
        // result message so the provider keeps it out of the cached prefix
        // (Anthropic) — see Message.releaseAfterRead.
        const call = taggedToolCalls.find(tc => tc.id === r.tool_call_id);
        const releaseAfterRead = call?.args?.release_after_read === true;
        const msg: Message = {
          role: 'tool', tool_call_id: r.tool_call_id, content: JSON.stringify(r.content),
          ...(releaseAfterRead ? { releaseAfterRead: true } : {}),
        };
        this.messages.push(msg);
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
      const result = await this.invokeWithFallback(this.messages, { tools: this.allToolDefs, tool_choice: toolChoice, disableCache: this.disableCache, signal: this.abortController.signal });
      const turnDuration = Date.now() - turnStart;

      usage.inputTokens         += this.sumInputTokens(result.usage);              // total for display
      usage.cacheCreationTokens += result.usage?.cache_creation_input_tokens || 0;
      usage.cacheReadTokens     += result.usage?.cache_read_input_tokens     || 0;
      usage.outputTokens        += result.usage?.output_tokens               || 0;
      // Recalculate with per-type breakdown so cache rates are applied correctly
      usage.totalCostUSD = this.calculateCost({
        input_tokens:                usage.inputTokens - usage.cacheCreationTokens - usage.cacheReadTokens,
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

  // ───────────────────────────────────────────────────────────────────────────
  // Argument normalization (direct-call boundary)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Schema-aware coercion of stringified tool arguments.
   *
   * When the LLM emits a tool call directly, it frequently encodes structured or
   * primitive arguments as JSON *strings* — `to: "[\"a@b.com\"]"`, `payload: "{...}"`,
   * `limit: "5"`, `dryRun: "true"`. Some downstream tools coerce defensively and some
   * don't: the dispatch executor read `payload.meetingId` off a raw string and aborted
   * the whole cart with a non-retryable error. This is the single normalization point
   * at the direct-call boundary: for every top-level parameter, if the incoming value
   * is a string and the schema declares a concrete type, we coerce to that type — but
   * ONLY when the coercion is unambiguous and lossless. Anything uncertain is left
   * untouched so normal downstream validation produces a clean error.
   *
   * Coercion policy (top-level params only):
   *  - `array` / `object`   → `JSON.parse`, accepted only if the parse yields that type.
   *  - `number` / `integer` → accepted only if the trimmed string round-trips exactly
   *    (`String(Number(s)) === s`). This rejects big-int precision loss (a 19-digit id
   *    typed as number stays a string), leading zeros, exponent/hex forms, `""`, and
   *    `NaN`/`Infinity`. `integer` additionally requires an integer value.
   *  - `boolean`            → accepted only for the exact literals `"true"` / `"false"`.
   *
   * Deliberate non-goals — each of these has a real downside, so we do NOT do them:
   *  - A param whose schema ALLOWS `string` is never coerced: the raw string is already
   *    schema-valid, so changing it could alter caller intent (union `["string","number"]`).
   *  - No recursion into nested values — a stringified element inside an array/object is
   *    left alone, because recursing risks corrupting legitimate string content.
   *  - No `null`/loose-boolean (`"yes"`, `"1"`) coercion — too ambiguous to be safe.
   *  - Parse failures, type mismatches, and lossy conversions leave the value as-is.
   *
   * Union types (`type: ["number","null"]`) are honored if they include the target.
   * Copy-on-write: the caller's args object is never mutated in place.
   *
   * Envelope rescue (whole-args collapse, not a single field): models also
   * frequently call a direct-schema tool by wrapping its ENTIRE argument set
   * inside a single non-schema `params` key holding a JSON string — mimicking
   * the shape of the generic `execute_tool({tool_name, params})` meta-tool —
   * e.g. `create_task({ params: "{\"title\":\"...\"}" })` instead of
   * `create_task({ title: "..." })`. Left alone, the handler sees none of its
   * expected named fields and fails with a generic "title is required"-style
   * error even though a title WAS supplied, just nested one level too deep —
   * no actionable signal, so the model often repeats the same mistake. When
   * args reduce to exactly one key named `params` holding a JSON-parseable
   * string, AND the tool's own schema does not itself declare a `params`
   * property (so a tool that legitimately has one is never misfired on), we
   * parse that string and splat its properties in as the top-level args. A
   * parse failure or non-object result falls through to normal validation —
   * but we log a diagnostic first so a future failure is traceable instead of
   * repeating the current generic error with no context.
   *
   * Every tool call — system, custom, dispatch, and `execute_tool` itself — flows
   * through `handleToolCalls`, so this single point brings direct calls to parity
   * with what the meta-tool path already does.
   */
  protected normalizeToolArgs(name: string, args: Record<string, any>): Record<string, any> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;

    const def = this.allToolDefs.find(d => d.function?.name === name);
    const properties = def?.function?.parameters?.properties;
    if (!properties || typeof properties !== 'object') return args;

    let workingArgs = args;
    const argKeys = Object.keys(args);
    if (
      argKeys.length === 1 &&
      argKeys[0] === 'params' &&
      typeof args.params === 'string' &&
      !('params' in (properties as Record<string, any>))
    ) {
      let parsed: any;
      let parseError: any;
      try {
        parsed = JSON.parse(args.params);
      } catch (err: any) {
        parseError = err;
      }
      const isPlainObject = !parseError && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      if (isPlainObject) {
        workingArgs = parsed;
      } else {
        this.log(
          `[BaseExecutor] Tool '${name}' was called with its entire argument set wrapped in a single ` +
          `'params' JSON string (execute_tool-style) instead of its own top-level arguments, and the ` +
          `value ${parseError ? `could not be JSON-parsed (${parseError.message})` : 'did not parse to an object'} ` +
          '— falling through to normal validation.'
        );
      }
    }

    let out: Record<string, any> | null = workingArgs === args ? null : workingArgs; // copy-on-write — only allocated if we actually coerce or already rescued
    const coerce = (key: string, parsed: any) => {
      if (!out) out = { ...workingArgs }; // never mutate the caller's args object in place
      out[key] = parsed;
    };

    for (const [key, value] of Object.entries(workingArgs)) {
      if (typeof value !== 'string') continue;

      const declaredType = (properties as Record<string, any>)[key]?.type;
      const types = Array.isArray(declaredType) ? declaredType : [declaredType];

      // A param that legitimately accepts a string is already valid as-is — never
      // coerce it, even if the value looks like JSON / a number / a boolean.
      if (types.includes('string')) continue;

      // ── array / object: JSON.parse, accept only on an exact type match ──
      if (types.includes('array') || types.includes('object')) {
        let parsed: any;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue; // not valid JSON — leave it for normal validation
        }
        const parsedIsArray  = Array.isArray(parsed);
        const parsedIsObject = parsed !== null && typeof parsed === 'object' && !parsedIsArray;
        if ((types.includes('array') && parsedIsArray) || (types.includes('object') && parsedIsObject)) {
          coerce(key, parsed);
        }
        continue;
      }

      // ── number / integer: accept only on an exact, lossless round-trip ──
      if (types.includes('number') || types.includes('integer')) {
        const trimmed = value.trim();
        if (trimmed === '') continue;
        const n = Number(trimmed);
        if (!Number.isFinite(n)) continue;     // NaN / Infinity → leave it
        if (String(n) !== trimmed) continue;   // big-int loss / "01" / "1e3" / "1.0" → leave it
        if (types.includes('integer') && !Number.isInteger(n)) continue;
        coerce(key, n);
        continue;
      }

      // ── boolean: exact literals only ──
      if (types.includes('boolean')) {
        const tb = value.trim();
        if (tb === 'true') coerce(key, true);
        else if (tb === 'false') coerce(key, false);
        continue;
      }

      // any other / untyped param → never touched
    }

    return out ?? workingArgs;
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

      // Single normalization point at the direct-call boundary: coerce
      // stringified array/object args to their schema-declared types so direct
      // tool calls behave identically to the execute_tool meta-tool path.
      tc.args = this.normalizeToolArgs(tc.name, tc.args);

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
          toolResult = { completed: false, error: true, message: `Tool '${tc.name}' not found. Most tools are lazy-loaded — call fetch_tools() with no args to see all groups, or fetch_tools({name: "${tc.name}"}) to check spelling. Then call execute_tool({tool_name, params}) to run it.` };
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

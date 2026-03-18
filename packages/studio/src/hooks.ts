/**
 * HookRegistry — fires OpenClaw-compatible hooks at key execution points.
 *
 * Handlers run in priority order (lower number = higher priority).
 * Modifying hooks merge their results into the payload.
 *
 * Supported hooks (Phase 4):
 *   before_agent_start   — fires at start of execute(), can modify modelOverride/promptExtra
 *   before_prompt_build  — fires before system prompt assembly, can prepend/append context
 *   before_tool_call     — fires before each tool execution, can block or modify params
 *   after_tool_call      — fires after each tool result (observability only)
 *   llm_input            — fires before LLM API call (observability only)
 *   llm_output           — fires after LLM response (observability only)
 *   agent_end            — fires on execution complete (cleanup)
 */

export type HookEvent =
  | 'before_agent_start'
  | 'before_prompt_build'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'llm_input'
  | 'llm_output'
  | 'agent_end';

export interface HookHandler {
  (payload: Record<string, any>, ctx: Record<string, any>): Promise<Record<string, any> | void>;
}

interface RegisteredHook {
  event: HookEvent;
  handler: HookHandler;
  priority: number;
}

export class HookRegistry {
  private hooks: RegisteredHook[] = [];

  /**
   * Register a hook handler for an event.
   */
  register(event: HookEvent, handler: HookHandler, priority = 0): void {
    this.hooks.push({ event, handler, priority });
    // Keep sorted by priority (ascending = higher priority first)
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Register multiple hooks at once (from plugin loader output).
   */
  registerAll(hooks: Array<{ event: string; handler: HookHandler; priority?: number }>): void {
    for (const h of hooks) {
      this.register(h.event as HookEvent, h.handler, h.priority ?? 0);
    }
  }

  /**
   * Fire all handlers for an event in priority order.
   *
   * For modifying hooks (before_*), results are merged into the payload.
   * For observability hooks (after_*, llm_*), results are ignored.
   *
   * @returns The merged result (for modifying hooks) or undefined (for observability hooks)
   */
  async fire(
    event: HookEvent,
    payload: Record<string, any>,
    ctx: Record<string, any> = {}
  ): Promise<Record<string, any> | undefined> {
    const handlers = this.hooks.filter(h => h.event === event);
    if (handlers.length === 0) return undefined;

    const isModifying = event.startsWith('before_');
    let merged = isModifying ? { ...payload } : undefined;

    for (const h of handlers) {
      try {
        const result = await h.handler(isModifying ? merged! : payload, ctx);
        if (isModifying && result && typeof result === 'object') {
          merged = { ...merged, ...result };
        }
      } catch (err) {
        // Hook errors should not break the execution pipeline
        console.error(`[HookRegistry] Error in ${event} handler:`, err);
      }
    }

    return merged;
  }

  /**
   * Check if any handlers are registered for an event.
   */
  has(event: HookEvent): boolean {
    return this.hooks.some(h => h.event === event);
  }

  /**
   * Get the number of registered handlers.
   */
  get size(): number {
    return this.hooks.length;
  }
}

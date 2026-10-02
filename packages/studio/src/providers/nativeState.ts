import type { Message, NativeState, ReasoningSummary, ReasoningConfig } from '../types.js';

export function nativeItems(message: Message, provider: string, model: string, format: NativeState['format']): any[] | undefined {
  const state = message.nativeState;
  if (message.role !== 'assistant' || !state || state.provider !== provider || state.model !== model || state.format !== format || !Array.isArray(state.items)) return undefined;
  return state.items;
}

// Legacy snapshots lack provenance. Accept only recognizable provider parts;
// a present but incompatible envelope must never fall through to rawParts.
export function legacyParts(message: Message, format: 'anthropic-content' | 'gemini-parts'): any[] | undefined {
  if (message.nativeState || !Array.isArray(message.rawParts) || !message.rawParts.length) return undefined;
  const valid = message.rawParts.every(part => {
    if (!part || typeof part !== 'object') return false;
    if (format === 'anthropic-content') {
      return (part.type === 'thinking' && typeof part.thinking === 'string' && typeof part.signature === 'string' && part.signature.length > 0)
        || (part.type === 'redacted_thinking' && typeof part.data === 'string');
    }
    return !('type' in part) && !('signature' in part) &&
      (!('thoughtSignature' in part) || (typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0)) &&
      (!('thought' in part) || typeof part.thought === 'boolean') &&
      (typeof part.text === 'string' || (part.functionCall && typeof part.functionCall.name === 'string') ||
        part.inlineData || part.fileData || part.executableCode || part.codeExecutionResult || typeof part.thoughtSignature === 'string');
  });
  return valid ? message.rawParts : undefined;
}

export function responsesSummaries(items: any[]): ReasoningSummary[] {
  return items.filter(item => item?.type === 'reasoning').flatMap(item =>
    (item.summary ?? []).filter((part: any) => part?.type === 'summary_text' && typeof part.text === 'string')
      .map((part: any) => ({ type: 'summary_text' as const, text: part.text })));
}

export function requestReasoningConfig(provider: string, model: string, params: any): ReasoningConfig {
  const settings: ReasoningConfig['settings'] = {};
  const fields = { reasoning: ['effort', 'summary', 'context'], thinking: ['type', 'budget_tokens', 'display'], output_config: ['effort'], thinkingConfig: ['thinkingLevel', 'thinkingBudget', 'includeThoughts'] } as const;
  for (const [key, names] of Object.entries(fields)) {
    const source = key === 'thinkingConfig' ? params.generationConfig?.thinkingConfig : params[key];
    if (!source) continue;
    const selected = Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
    if (Object.keys(selected).length) (settings as any)[key] = selected;
  }
  if (params.thinking?.block_binding?.prefix_mismatch_behavior !== undefined) {
    settings.thinking = { ...(settings.thinking || {}), block_binding: { prefix_mismatch_behavior: params.thinking.block_binding.prefix_mismatch_behavior } };
  }
  return { provider, model, source: 'provider-request', settings };
}

/** Trace only canonical answer/tool fields and public summaries. */
export function traceMessage(message: Message): Message {
  const { nativeState, rawParts, ...visible } = message;
  return visible;
}

/** Counts exposed native reasoning/signature parts, not internal deliberation.
 * An absent envelope/legacy parts leaves the observation unknown. */
export function nativeStatePresence(message?: Message): { present: boolean; provider?: string; model?: string; format?: string; observedReasoningParts?: number } {
  const state = message?.nativeState;
  if (state) {
    const observedReasoningParts = state.items.filter(part => state.format === 'openai-responses' ? part?.type === 'reasoning'
      : state.format === 'anthropic-content' ? part?.type === 'thinking' || part?.type === 'redacted_thinking'
      : part?.thought === true || typeof part?.thoughtSignature === 'string').length;
    return { present: true, provider: state.provider, model: state.model, format: state.format, observedReasoningParts };
  }
  if (message?.rawParts?.length) return { present: true, observedReasoningParts: message.rawParts.filter(part => part?.type === 'thinking' || part?.type === 'redacted_thinking' || part?.thought === true || typeof part?.thoughtSignature === 'string').length };
  return { present: false };
}

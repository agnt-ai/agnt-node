import type { Message, NativeState, ReasoningSummary, ReasoningConfig } from '../types.js';

export const GEMINI_IMPORTED_HISTORY_SIGNATURE = 'skip_thought_signature_validator';

export function nativeItems(message: Message, provider: string, model: string, format: NativeState['format']): any[] | undefined {
  const state = message.nativeState;
  if (message.role !== 'assistant' || !state || state.provider !== provider || state.model !== model || state.format !== format || !Array.isArray(state.items)) return undefined;
  return reconcileNativeItems(message, state.items, format);
}

/** Canonical IDs/content can be repaired or removed by a harness after capture.
 * Keep opaque blocks intact, but replay the current canonical exchange once. */
function reconcileNativeItems(message: Message, items: any[], format: NativeState['format']): any[] {
  const calls = message.tool_calls ?? [];
  const nativeCalls = items.map((item, index) => {
    if (format === 'openai-responses' && item?.type === 'function_call') {
      let args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch { /* canonical extractor uses {} */ }
      return { index, id: item.call_id, name: item.name, args };
    }
    if (format === 'anthropic-content' && item?.type === 'tool_use') return { index, id: item.id, name: item.name, args: item.input };
    if (format === 'gemini-parts' && item?.functionCall) return { index, id: item.functionCall.name, name: item.functionCall.name, args: item.functionCall.args || {} };
    return undefined;
  }).filter((call): call is NonNullable<typeof call> => Boolean(call));
  const claimed = new Set<number>();
  const paired = new Map<number, number>();
  const equal = (a: any, b: any): boolean => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  };

  // Duplicate Gemini function-name IDs are not stable identities. Match their
  // arguments first, so orphan filtering cannot move another call's signature.
  for (const original of nativeCalls) {
    const duplicates = nativeCalls.filter(call => call.id === original.id);
    const targets = calls.map((call, index) => ({ call, index })).filter(({ call, index }) => !claimed.has(index) && call.id === original.id && (duplicates.length === 1 || equal(call.args, original.args)));
    const equivalent = duplicates.filter(call => !paired.has(call.index) && equal(call.args, original.args));
    if (targets.length && (duplicates.length === 1 || equivalent.length === targets.length)) {
      paired.set(original.index, targets[0].index); claimed.add(targets[0].index);
    }
  }
  for (const original of nativeCalls.filter(call => !paired.has(call.index))) {
    const candidates = calls.map((call, index) => ({ call, index })).filter(({ call, index }) => !claimed.has(index) && call.name === original.name && equal(call.args, original.args));
    const remaining = nativeCalls.filter(call => !paired.has(call.index) && call.name === original.name && equal(call.args, original.args));
    if (candidates.length === 1 && remaining.length === 1 || candidates.length > 0 && candidates.length === remaining.length) {
      paired.set(original.index, candidates[0].index); claimed.add(candidates[0].index);
    }
  }
  // If only IDs/arguments were repaired and all calls remain, ordinal pairing
  // is safe after exact claims. With removals, require an unambiguous name.
  for (const original of nativeCalls.filter(call => !paired.has(call.index))) {
    const candidates = calls.map((call, index) => ({ call, index })).filter(({ call, index }) => !claimed.has(index) && call.name === original.name);
    const remaining = nativeCalls.filter(call => !paired.has(call.index) && call.name === original.name);
    if (candidates.length === 1 && remaining.length === 1 || calls.length === nativeCalls.length && candidates.length === remaining.length && candidates.length > 0) {
      paired.set(original.index, candidates[0].index); claimed.add(candidates[0].index);
    }
  }
  const originalText = items.flatMap(item => format === 'openai-responses' ? item?.type === 'message' ? item.content ?? [] : [] : [item])
    .filter(part => format === 'openai-responses' ? part?.type === 'output_text' || part?.type === 'refusal'
      : format === 'anthropic-content' ? part?.type === 'text' : typeof part?.text === 'string' && part.thought !== true)
    .map(part => format === 'openai-responses' && part.type === 'refusal' ? part.refusal ?? '' : part.text ?? '').join(format === 'anthropic-content' ? '\n' : '');
  const textArray = Array.isArray(message.content) && message.content.every(part => typeof part?.text === 'string' && ['text', 'input_text', 'output_text'].includes(part.type));
  const currentText = typeof message.content === 'string' ? message.content
    : textArray ? (message.content as any[]).map(part => part.text).join(format === 'anthropic-content' ? '\n' : '')
    : JSON.stringify(message.content);
  const textChanged = originalText !== currentText;
  let textWritten = false;
  const textPart = (part: any): any => {
    const visible = format === 'openai-responses' ? part?.type === 'output_text' || part?.type === 'refusal'
      : format === 'anthropic-content' ? part?.type === 'text' : typeof part?.text === 'string' && part.thought !== true;
    if (!textChanged || !visible) return part;
    const text = textWritten ? '' : currentText;
    textWritten = true;
    return { ...part, [part.type === 'refusal' ? 'refusal' : 'text']: text };
  };
  const makeCall = (call: NonNullable<Message['tool_calls']>[number], original?: any): any => {
    if (format === 'openai-responses') return { ...(original || { type: 'function_call' }), call_id: call.id, name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}) };
    if (format === 'anthropic-content') return { ...(original || { type: 'tool_use' }), id: call.id, name: call.name, input: call.args };
    return { ...(original || {}), functionCall: { ...(original?.functionCall || {}), name: call.name, args: call.args } };
  };
  const replay = items.flatMap((item, index) => {
    if (nativeCalls.some(call => call.index === index)) {
      const target = paired.get(index);
      if (target === undefined) return [];
      const call = calls[target];
      const original = nativeCalls.find(call => call.index === index)!;
      // Unedited output remains byte-for-byte identical, including JSON spacing.
      return [call.id === original.id && call.name === original.name && equal(call.args, original.args) ? item : makeCall(call, item)];
    }
    return [format === 'openai-responses' && item?.type === 'message' && textChanged ? { ...item, content: (item.content ?? []).map(textPart) } : textPart(item)];
  });
  if (textChanged && !textWritten && currentText) replay.push(format === 'openai-responses'
    ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: currentText }] }
    : format === 'anthropic-content' ? { type: 'text', text: currentText } : { text: currentText });
  calls.forEach((call, index) => {
    if (!claimed.has(index)) {
      const reconstructed = makeCall(call);
      replay.push(format === 'gemini-parts' ? { ...reconstructed, thoughtSignature: GEMINI_IMPORTED_HISTORY_SIGNATURE } : reconstructed);
    }
  });
  if (format === 'gemini-parts') {
    // A canonical edit creates imported/reconstructed history. Do not attach
    // one call's opaque signature to a different call or changed arguments.
    // Use only the documented import sentinel for these edited call parts.
    // https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
    for (const original of nativeCalls) {
      const target = paired.get(original.index);
      if (target === undefined || typeof items[original.index]?.thoughtSignature !== 'string') continue;
      if (!equal(calls[target].args, original.args) || calls[target].name !== original.name) {
        const partIndex = replay.findIndex(part => part?.functionCall === items[original.index]?.functionCall || part?.functionCall?.name === calls[target].name && equal(part.functionCall.args, calls[target].args));
        if (partIndex >= 0) replay[partIndex] = { ...replay[partIndex], thoughtSignature: GEMINI_IMPORTED_HISTORY_SIGNATURE };
      }
    }
    const removedSignedCall = nativeCalls.some(call => !paired.has(call.index) && typeof items[call.index]?.thoughtSignature === 'string');
    const reconstructedCall = calls.some((_, index) => !claimed.has(index));
    if (removedSignedCall || reconstructedCall) {
      const first = replay.findIndex(part => part?.functionCall);
      if (first >= 0 && !replay[first].thoughtSignature) replay[first] = { ...replay[first], thoughtSignature: GEMINI_IMPORTED_HISTORY_SIGNATURE };
    }
  }
  return replay;
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
  return valid ? format === 'gemini-parts' ? reconcileNativeItems(message, message.rawParts, format) : message.rawParts : undefined;
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

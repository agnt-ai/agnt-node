/** Model-specific mapping for Generate Content, not the Interactions API.
 * Explicit native budgets/levels win. Unsupported tiers/models keep defaults.
 * Budget choices for 2.5 are SDK policy within documented provider ranges.
 * https://ai.google.dev/gemini-api/docs/generate-content/thinking */
export function geminiThinkingConfig(model: string, effort: unknown, existing?: Record<string, any>): Record<string, any> | undefined {
  if (existing?.thinkingLevel != null || existing?.thinkingBudget != null || typeof effort !== 'string') return existing;
  const id = model.replace(/^models\//, '').toLowerCase();
  let mapped: Record<string, any> | undefined;
  if (/^gemini-2\.5-(pro|flash)(-|$)/.test(id) && !/image|audio|live|tts/.test(id)) {
    const budgets: Record<string, number> = { low: 1024, medium: 8192, high: 16384 };
    if (budgets[effort] != null) mapped = { thinkingBudget: budgets[effort] };
    if (effort === 'none' && /^gemini-2\.5-flash/.test(id)) mapped = { thinkingBudget: 0 };
  } else {
    // Only listed supported model families. Unknown future models are untouched.
    const levels = /^gemini-3-pro(-|$)/.test(id) ? ['low', 'high']
      : /^gemini-3\.1-pro(-|$)/.test(id) ? ['low', 'medium', 'high']
      : /^gemini-3\.(7|8)-flash(-|$)/.test(id) ? ['low', 'medium', 'high']
      : /^gemini-(3-flash|3\.(5|6)-flash|3\.(1|5)-flash-lite)(-|$)/.test(id) && !/image/.test(id) ? ['minimal', 'low', 'medium', 'high']
      : [];
    if (levels.includes(effort)) mapped = { thinkingLevel: effort };
  }
  return mapped ? { ...(existing || {}), ...mapped } : existing;
}

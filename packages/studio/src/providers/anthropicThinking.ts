/** Current documented forced-tool restrictions. Pass the actual request thinking
 * configuration; effort alone does not establish a mode.
 * https://platform.claude.com/docs/en/build-with-claude/thinking */
export function anthropicSupportsForcedTools(model: string, thinking?: { type?: string }): boolean {
  return !/^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(-|$)/i.test(model)
    && thinking?.type !== 'enabled';
}

/** Match only the documented conversation-binding error, not bad/tampered signatures. */
export function isAnthropicPrefixMismatch(error: any): boolean {
  if (error?.status !== 400) return false;
  const message = error?.error?.error?.message ?? error?.error?.message ?? error?.message;
  return typeof message === 'string' && /messages\.\d+\.content\.\d+: Invalid `signature` in `thinking` block\. The block is bound to a different conversation\./.test(message);
}

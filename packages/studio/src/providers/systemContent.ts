/**
 * System messages with a cache boundary.
 *
 * A caller whose system prompt has a stable prefix and a part that changes every call (a clock, live state) sends the
 * system message's content as text parts, marking the last part of the stable prefix with `cacheBoundary: true`:
 *
 *   { role: 'system', content: [
 *     { type: 'text', text: STABLE, cacheBoundary: true },
 *     { type: 'text', text: PER_CALL },
 *   ] }
 *
 * - Anthropic (explicit breakpoints): each part becomes its own system text block and the breakpoint goes on the
 *   marked one, so the stable prefix is read from the provider cache across calls while the part after it changes.
 * - Every other provider (automatic prefix caching: OpenAI, Azure, OpenAI-compatible, Gemini; Bedrock: none) gets the
 *   parts joined by a blank line, exactly the text a caller would have sent as one string. The stable prefix comes
 *   first and is byte-identical, which is all automatic prefix caching needs.
 *
 * A system message whose content is a string is unchanged everywhere.
 */
import type { Message } from '../types.js';

/** Exported by the package so a caller can tell whether this version understands `cacheBoundary` system parts. */
export const SYSTEM_CACHE_BOUNDARY_SUPPORT = 1;

export const SYSTEM_PART_SEPARATOR = '\n\n';

function partText(part: any): string {
  if (typeof part === 'string') return part;
  if (part && typeof part.text === 'string') return part.text;
  return '';
}

/** A system message's content as one string: a string as is, text parts joined by a blank line. */
export function systemText(content: Message['content'] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map(partText).filter(Boolean).join(SYSTEM_PART_SEPARATOR);
}

/** The messages with every system message's content flattened to one string; the same array when there is none. */
export function withFlatSystemMessages(messages: Message[]): Message[] {
  if (!messages.some(m => m.role === 'system' && Array.isArray(m.content))) return messages;
  return messages.map(m => (m.role === 'system' && Array.isArray(m.content) ? { ...m, content: systemText(m.content) } : m));
}

/**
 * Anthropic's `system` parameter. Without parts it is today's shape: one block holding every system message joined,
 * cached at its end (or the bare string when caching is off). With parts, one text block per part (and per string
 * system message), cached at the last part marked `cacheBoundary`, or at the last block when none is marked.
 */
export function anthropicSystem(messages: Message[], cacheOn: boolean): string | any[] | undefined {
  const system = messages.filter(m => m.role === 'system');
  const joined = system.map(m => systemText(m.content)).join(SYSTEM_PART_SEPARATOR);
  if (!joined) return undefined;
  const hasParts = system.some(m => Array.isArray(m.content));
  if (!cacheOn) return joined;
  const EPHEMERAL = { type: 'ephemeral' as const };
  if (!hasParts) return [{ type: 'text', text: joined, cache_control: EPHEMERAL }];

  const blocks: Array<{ type: 'text'; text: string; boundary: boolean }> = [];
  for (const m of system) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const text = partText(part);
        if (text) blocks.push({ type: 'text', text, boundary: part?.cacheBoundary === true });
      }
    } else {
      const text = systemText(m.content);
      if (text) blocks.push({ type: 'text', text, boundary: false });
    }
  }
  let at = -1;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].boundary) at = i;
  if (at < 0) at = blocks.length - 1;
  // Each later block starts with the separator, so the model reads exactly the joined text and the marked block's own
  // bytes never depend on what follows it.
  return blocks.map((b, i) => {
    const text = i === 0 ? b.text : SYSTEM_PART_SEPARATOR + b.text;
    return i === at ? { type: 'text', text, cache_control: EPHEMERAL } : { type: 'text', text };
  });
}

/**
 * OpenClaw ↔ AGNT tool result format adapter.
 *
 * OpenClaw tools return: { content: [{ type: 'text', text: '...' }], details?: any }
 * AGNT tools return:     { completed: true, data: ... } or arbitrary JSON
 *
 * This module bridges the two formats so OpenClaw plugins work seamlessly
 * in AGNT's executor pipeline, and AGNT results can be consumed by
 * OpenClaw-compatible tooling.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpenClawContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface OpenClawToolResult {
  content: OpenClawContentBlock[];
  isError?: boolean;
  details?: any;
}

export interface AGNTToolResult {
  completed: boolean;
  error?: boolean;
  message?: string;
  data?: any;
  [key: string]: any;
}

export interface ToolHandler {
  execute: (args: any) => Promise<any>;
}

export interface OpenClawToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  execute: (args: any, ctx?: any) => Promise<OpenClawToolResult>;
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect whether a tool result is in OpenClaw format.
 * OpenClaw results have a `.content` array where each item has a `.type` field.
 */
export function isOpenClawResult(result: any): result is OpenClawToolResult {
  if (!result || typeof result !== 'object') return false;
  if (!Array.isArray(result.content)) return false;
  if (result.content.length === 0) return false;
  return result.content.every(
    (item: any) => item && typeof item === 'object' && typeof item.type === 'string'
  );
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert an OpenClaw tool result to AGNT format.
 */
export function fromOpenClawResult(result: OpenClawToolResult): AGNTToolResult {
  if (result.isError) {
    const errorText = result.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    return { completed: false, error: true, message: errorText || 'Tool error' };
  }

  // Extract text content
  const textParts = result.content
    .filter(b => b.type === 'text')
    .map(b => b.text);

  const combined = textParts.join('\n');

  // Try to parse as JSON for structured data
  if (textParts.length === 1) {
    try {
      const parsed = JSON.parse(combined);
      return { completed: true, data: parsed };
    } catch {
      // Not JSON — return as text
    }
  }

  return {
    completed: true,
    data: combined,
    ...(result.details ? { details: result.details } : {}),
  };
}

/**
 * Convert an AGNT tool result to OpenClaw format.
 */
export function toOpenClawResult(result: any): OpenClawToolResult {
  if (result === null || result === undefined) {
    return { content: [{ type: 'text', text: '' }] };
  }

  // Already in OpenClaw format
  if (isOpenClawResult(result)) return result;

  const isError = result.error === true || result.completed === false;
  const text = typeof result === 'string'
    ? result
    : JSON.stringify(result, null, 2);

  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

// ── Tool Wrapping ────────────────────────────────────────────────────────────

/**
 * Wrap an OpenClaw tool definition for use in AGNT's tool router.
 * The returned handler normalizes the OpenClaw result to AGNT format.
 */
export function adaptOpenClawTool(tool: OpenClawToolDefinition, ctx?: any): ToolHandler {
  return {
    execute: async (args: any) => {
      const result = await tool.execute(args, ctx);
      return fromOpenClawResult(result);
    },
  };
}

/**
 * Normalize any tool result to AGNT format.
 * If it's an OpenClaw result, convert it. Otherwise pass through.
 */
export function normalizeToolResult(result: any): any {
  if (isOpenClawResult(result)) {
    return fromOpenClawResult(result);
  }
  return result;
}

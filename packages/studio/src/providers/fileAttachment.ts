/**
 * fileAttachment — translate the cross-provider "file" content block into each
 * provider's native document shape.
 *
 * The canonical block (emitted by callers, OpenAI-native so OpenAI needs no
 * translation) is:
 *
 *   { type: 'file', file: { filename?: string, file_data: 'data:<mime>;base64,<b64>' } }
 *
 * Used for PDFs and other documents. Images use the separate `image_url` block.
 * Each provider adapter calls the matching helper below; OpenAI passes the block
 * through unchanged (its SDK accepts this shape directly).
 */

/** Pull the base64 data URL string out of a file block (object or bare string). */
function fileDataUrl(item: any): string | null {
  const fd = typeof item?.file === 'string' ? item.file : item?.file?.file_data;
  return typeof fd === 'string' ? fd : null;
}

/** Parse a `data:<mime>;base64,<data>` URL into its parts, or null. */
export function parseBase64DataUrl(url: string | null): { mediaType: string; data: string } | null {
  if (!url || !url.startsWith('data:')) return null;
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

/** Anthropic Messages API document block. */
export function fileToAnthropicDocument(item: any): any | null {
  const parsed = parseBase64DataUrl(fileDataUrl(item));
  if (!parsed) return null;
  const title = item?.file?.filename;
  return {
    type: 'document',
    source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
    ...(title ? { title } : {}),
  };
}

/** Gemini inline-data part (PDFs are sent the same way as images). */
export function fileToGeminiPart(item: any): any | null {
  const parsed = parseBase64DataUrl(fileDataUrl(item));
  if (!parsed) return null;
  return { inlineData: { mimeType: parsed.mediaType, data: parsed.data } };
}

// Bedrock Converse only accepts a fixed set of document formats.
const BEDROCK_DOC_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * Sanitize a filename for Bedrock's document `name` field. Bedrock allows only
 * alphanumerics, whitespace, hyphens, parentheses, and square brackets, with no
 * consecutive whitespace.
 */
export function bedrockDocName(filename?: string): string {
  const base = (filename || 'document').replace(/\.[a-z0-9]+$/i, '');
  const cleaned = base.replace(/[^a-zA-Z0-9\s\-()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'document';
}

/** Bedrock Converse document content block. Returns null for unsupported formats. */
export function fileToBedrockDocument(item: any): any | null {
  const parsed = parseBase64DataUrl(fileDataUrl(item));
  if (!parsed) return null;
  const format = BEDROCK_DOC_FORMATS[parsed.mediaType];
  if (!format) return null;
  return {
    document: {
      format,
      name: bedrockDocName(item?.file?.filename),
      source: { bytes: Buffer.from(parsed.data, 'base64') },
    },
  };
}

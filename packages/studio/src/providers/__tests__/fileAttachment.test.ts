import { describe, it, expect } from 'vitest';
import {
  parseBase64DataUrl,
  fileToAnthropicDocument,
  fileToGeminiPart,
  fileToBedrockDocument,
  bedrockDocName,
} from '../fileAttachment.js';

const pdf = (filename?: string) => ({
  type: 'file',
  file: { ...(filename ? { filename } : {}), file_data: 'data:application/pdf;base64,JVBERi0x' },
});

describe('parseBase64DataUrl', () => {
  it('parses mime + data', () => {
    expect(parseBase64DataUrl('data:application/pdf;base64,JVBERi0x')).toEqual({
      mediaType: 'application/pdf',
      data: 'JVBERi0x',
    });
  });
  it('returns null for non-data-URLs and junk', () => {
    expect(parseBase64DataUrl('https://x/y.pdf')).toBeNull();
    expect(parseBase64DataUrl('')).toBeNull();
    expect(parseBase64DataUrl(null)).toBeNull();
  });
});

describe('fileToAnthropicDocument', () => {
  it('builds a base64 document block with title from filename', () => {
    expect(fileToAnthropicDocument(pdf('report.pdf'))).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
      title: 'report.pdf',
    });
  });
  it('omits title when no filename', () => {
    const doc = fileToAnthropicDocument(pdf());
    expect(doc.title).toBeUndefined();
    expect(doc.source.media_type).toBe('application/pdf');
  });
  it('accepts a bare-string file field', () => {
    const doc = fileToAnthropicDocument({ type: 'file', file: 'data:application/pdf;base64,JVBERi0x' });
    expect(doc.source.data).toBe('JVBERi0x');
  });
  it('returns null when data URL is missing', () => {
    expect(fileToAnthropicDocument({ type: 'file', file: {} })).toBeNull();
  });
});

describe('fileToGeminiPart', () => {
  it('builds an inlineData part', () => {
    expect(fileToGeminiPart(pdf('x.pdf'))).toEqual({
      inlineData: { mimeType: 'application/pdf', data: 'JVBERi0x' },
    });
  });
  it('returns null without a data URL', () => {
    expect(fileToGeminiPart({ type: 'file', file: {} })).toBeNull();
  });
});

describe('fileToBedrockDocument', () => {
  it('builds a Converse document block with decoded bytes', () => {
    const doc = fileToBedrockDocument(pdf('Q3 report.pdf'));
    expect(doc.document.format).toBe('pdf');
    expect(doc.document.name).toBe('Q3 report');
    expect(Buffer.isBuffer(doc.document.source.bytes)).toBe(true);
    expect(doc.document.source.bytes.toString('base64')).toBe('JVBERi0x');
  });
  it('returns null for formats Bedrock does not accept', () => {
    expect(fileToBedrockDocument({ type: 'file', file: { file_data: 'data:image/png;base64,AAAA' } })).toBeNull();
  });
  it('maps common office mimes to formats', () => {
    const docx = { type: 'file', file: { filename: 'a.docx', file_data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA' } };
    expect(fileToBedrockDocument(docx).document.format).toBe('docx');
  });
});

describe('bedrockDocName', () => {
  it('strips extension and illegal chars, collapses whitespace', () => {
    expect(bedrockDocName('My_Report@2026!!.pdf')).toBe('My Report 2026');
    expect(bedrockDocName('a/b\\c.pdf')).toBe('a b c');
  });
  it('falls back to "document" when empty', () => {
    expect(bedrockDocName('')).toBe('document');
    expect(bedrockDocName('***.pdf')).toBe('document');
  });
});

/**
 * Adapter-level content-translation tests.
 *
 * These prove the cross-provider contract END TO END at the adapter boundary —
 * not just the pure helpers. A user message carrying an `image_url` block and a
 * `file` block is run through each provider's real #formatContent (via invoke()
 * with a mocked SDK client), and we assert the exact payload handed to the
 * provider SDK.
 *
 * Why this matters: callers (resolveMessageFiles) now emit `image_url` for
 * images and `file` for PDFs. The `image_url` path in particular had NO direct
 * SDK test before — this pins it, plus the new `file` translation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  anthropicMessageStream,
  openAIStreamFromCompletion,
  googleStreamResult,
} from './_streamMocks.js';

// invoke() streams; the adapters see the same params. We assert the exact
// payload handed to each provider's stream call.
const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

const googleGenerateContentStream = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContentStream: googleGenerateContentStream }),
  })),
}));

const anthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: anthropicStream },
  })),
}));

import OpenAIExecutor from '../providers/openai.js';
import GoogleExecutor from '../providers/google.js';
import AnthropicExecutor from '../providers/anthropic.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

function makeConfig(provider: string, model: string, creds: any): BaseExecutorConfig {
  const manifest: PromptManifestV2 = {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest',
    apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: {
      routingStrategy: 'fallback', enableToolCalls: false,
      variables: [], files: [], tools: [], models: [{ provider, model }], dependencies: [],
    },
  };
  return { manifest, credentials: creds, logLevel: 'silent' } as BaseExecutorConfig;
}

const IMG = 'data:image/jpeg;base64,SGVsbG8=';
const PDF = 'data:application/pdf;base64,JVBERi0x';

// A user turn with one image + one PDF (the multimodal shape resolveMessageFiles emits).
const multimodalTurn = [{
  role: 'user',
  content: [
    { type: 'text', text: 'look at these' },
    { type: 'image_url', image_url: { url: IMG } },
    { type: 'file', file: { filename: 'report.pdf', file_data: PDF } },
  ],
}];

beforeEach(() => vi.clearAllMocks());

describe('Anthropic adapter translation', () => {
  it('image_url → image.source.base64, file → document', async () => {
    anthropicStream.mockReturnValue(anthropicMessageStream({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = new AnthropicExecutor(makeConfig('anthropic', 'claude-haiku-4-5', { anthropic: { apiKey: 'k' } }));
    // disableCache → isolate content translation from the message-tail cache
    // breakpoint, which would otherwise attach cache_control to the last block.
    await ex.invoke(multimodalTurn as any, { disableCache: true });

    const content = anthropicStream.mock.calls[0][0].messages[0].content;
    expect(content).toContainEqual({ type: 'text', text: 'look at these' });
    expect(content).toContainEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'SGVsbG8=' },
    });
    expect(content).toContainEqual({
      type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' }, title: 'report.pdf',
    });
  });
});

describe('Google adapter translation', () => {
  it('image_url AND file → inlineData parts', async () => {
    googleGenerateContentStream.mockResolvedValue(
      googleStreamResult({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })
    );
    const ex = new GoogleExecutor(makeConfig('google', 'gemini-2.0-flash', { google: { apiKey: 'k' } }));
    await ex.invoke(multimodalTurn as any);

    const parts = googleGenerateContentStream.mock.calls[0][0].contents[0].parts;
    expect(parts).toContainEqual({ text: 'look at these' });
    expect(parts).toContainEqual({ inlineData: { mimeType: 'image/jpeg', data: 'SGVsbG8=' } });
    expect(parts).toContainEqual({ inlineData: { mimeType: 'application/pdf', data: 'JVBERi0x' } });
  });
});

describe('OpenAI adapter translation', () => {
  it('passes image_url and file blocks through unchanged (OpenAI-native)', async () => {
    openaiCreate.mockImplementation(async () =>
      openAIStreamFromCompletion({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );
    const ex = new OpenAIExecutor(makeConfig('openai', 'gpt-4o', { openai: { apiKey: 'k' } }));
    await ex.invoke(multimodalTurn as any);

    const content = openaiCreate.mock.calls[0][0].messages[0].content;
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: IMG } });
    expect(content).toContainEqual({ type: 'file', file: { filename: 'report.pdf', file_data: PDF } });
  });
});

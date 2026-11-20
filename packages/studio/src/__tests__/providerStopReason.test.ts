/**
 * Each provider's own stop reason and refusal cross the package boundary verbatim (InvokeResult.stopReason / .refusal),
 * the way Bedrock's Converse stopReason already does (providers/__tests__/bedrockStopReason.test.ts). The adapters do
 * not interpret them; what a refusal causes is the caller's policy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { anthropicMessageStream, openAIResponsesStreamFromResponse } from './_streamMocks.js';

const anthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { stream: anthropicStream } }; }),
}));
const chatCreate = vi.fn();
const responsesCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return {
    chat: { completions: { create: chatCreate } },
    responses: { create: responsesCreate },
  }; }),
}));

import AnthropicExecutor from '../providers/anthropic.js';
import AzureFoundryExecutor from '../providers/azureFoundry.js';
import OpenAIExecutor from '../providers/openai.js';
import { consumeOpenAIStream } from '../providers/streaming.js';

const manifest = (provider: string, model: string) => ({
  kind: 'PromptManifest', apiVersion: 'v2',
  spec: { models: [{ provider, model }], files: [], tools: [] },
}) as any;

async function* gen(chunks: any[]) { for (const c of chunks) yield c; }

beforeEach(() => { vi.clearAllMocks(); });

describe('consumeOpenAIStream', () => {
  it('keeps the streamed refusal and finish_reason', async () => {
    const out = await consumeOpenAIStream(gen([
      { choices: [{ index: 0, delta: { role: 'assistant', refusal: 'I cannot ' } }] },
      { choices: [{ index: 0, delta: { refusal: 'help with that.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
    ]), () => {});
    expect(out.choices[0].message.refusal).toBe('I cannot help with that.');
    expect(out.choices[0].finish_reason).toBe('stop');
  });

  it('adds nothing when the stream carries neither', async () => {
    const out = await consumeOpenAIStream(gen([{ choices: [{ index: 0, delta: { content: 'hi' } }] }]), () => {});
    expect(out.choices[0]).not.toHaveProperty('finish_reason');
    expect(out.choices[0].message).not.toHaveProperty('refusal');
  });
});

describe('AnthropicExecutor', () => {
  it('passes stop_reason through as stopReason', async () => {
    anthropicStream.mockReturnValue(anthropicMessageStream({
      content: [{ type: 'text', text: 'No.' }], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 2 },
    }));
    const ex = new AnthropicExecutor({ manifest: manifest('anthropic', 'claude-haiku-4-5'), credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent' } as any);
    const res = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(res.stopReason).toBe('refusal');
  });

  it('omits stopReason when the response has none', async () => {
    anthropicStream.mockReturnValue(anthropicMessageStream({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = new AnthropicExecutor({ manifest: manifest('anthropic', 'claude-haiku-4-5'), credentials: { anthropic: { apiKey: 'k' } }, logLevel: 'silent' } as any);
    const res = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(res).not.toHaveProperty('stopReason');
  });
});

describe('Chat Completions (OpenAI, Azure Foundry)', () => {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', refusal: 'I cannot help with that.' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } },
  ];

  it('OpenAI: finish_reason → stopReason, message.refusal → refusal', async () => {
    chatCreate.mockImplementation(async () => gen(chunks));
    const ex = new OpenAIExecutor({ manifest: manifest('openai', 'gpt-4o'), credentials: { openai: { apiKey: 'k' } }, logLevel: 'silent' } as any);
    const res = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(res.stopReason).toBe('content_filter');
    expect(res.refusal).toBe('I cannot help with that.');
  });

  // A refusal-only turn (no content) already throws there as a malformed empty response, which falls back; a filtered
  // turn that kept some text now says why it stopped.
  it('Azure Foundry: finish_reason → stopReason, refusal beside text → refusal', async () => {
    chatCreate.mockImplementation(async () => gen([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Part', refusal: 'I cannot help with that.' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } },
    ]));
    const ex = new AzureFoundryExecutor({ manifest: manifest('azureFoundry', 'gpt-4o'), credentials: { azureFoundry: { apiKey: 'k', endpoint: 'https://r.services.ai.azure.com' } }, logLevel: 'silent' } as any);
    const res = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(res.stopReason).toBe('content_filter');
    expect(res.refusal).toBe('I cannot help with that.');
  });
});

describe('Responses (OpenAI, Azure Foundry v1)', () => {
  const refused = {
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: "I'm sorry, I can't help with that." }] }],
    usage: { input_tokens: 40, output_tokens: 9 },
  };
  const filtered = {
    status: 'incomplete', incomplete_details: { reason: 'content_filter' },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Part' }] }],
    usage: { input_tokens: 40, output_tokens: 1 },
  };

  it('OpenAI: refusal parts → refusal (content unchanged); incomplete_details.reason → stopReason', async () => {
    responsesCreate.mockImplementationOnce(async () => openAIResponsesStreamFromResponse(refused));
    const ex = new OpenAIExecutor({ manifest: manifest('openai', 'gpt-5.6-luna'), credentials: { openai: { apiKey: 'k' } }, logLevel: 'silent' } as any);
    const a = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(a.refusal).toBe("I'm sorry, I can't help with that.");
    expect(a.message.content).toBe("I'm sorry, I can't help with that.");
    expect(a).not.toHaveProperty('stopReason');

    responsesCreate.mockImplementationOnce(async () => openAIResponsesStreamFromResponse(filtered));
    const b = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(b.stopReason).toBe('content_filter');
    expect(b).not.toHaveProperty('refusal');
  });

  it('Azure Foundry v1: the same', async () => {
    responsesCreate.mockImplementationOnce(async () => openAIResponsesStreamFromResponse(refused));
    const ex = new AzureFoundryExecutor({ manifest: manifest('azureFoundry', 'gpt-6-luna'), credentials: { azureFoundry: { apiKey: 'k', endpoint: 'https://r.services.ai.azure.com/openai/v1' } }, logLevel: 'silent' } as any);
    const a = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(a.refusal).toBe("I'm sorry, I can't help with that.");
    responsesCreate.mockImplementationOnce(async () => openAIResponsesStreamFromResponse(filtered));
    const b = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(b.stopReason).toBe('content_filter');
  });
});

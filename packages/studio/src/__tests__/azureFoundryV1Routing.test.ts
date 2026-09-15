/**
 * AzureFoundryExecutor's v1-mode detection and reasoning-family routing.
 *
 * Regression coverage for the 2026-09-14 prod incident: gpt-5.6-luna/terra
 * deployments on Azure AI Foundry only answer on the Azure OpenAI v1 API
 * (`{endpoint}/openai/v1`), not the unified Model Inference API
 * (`{endpoint}/models?api-version=...`) this adapter previously always used —
 * every call 400'd/404'd and silently fell back to direct OpenAI. See
 * openaiReasoningParams.test.ts for the OpenAI-side counterpart this mirrors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAIStreamFromCompletion, openAIResponsesStreamFromResponse } from './_streamMocks.js';

const azureChatCreate = vi.fn();
const azureResponsesCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return {
    chat: { completions: { create: azureChatCreate } },
    responses: { create: azureResponsesCreate },
  }; }),
}));

import AzureFoundryExecutor from '../providers/azureFoundry.js';

function makeManifest(model: string, metadata: Record<string, any> = {}) {
  return {
    kind: 'PromptManifest',
    apiVersion: 'v2',
    spec: {
      models: [{ provider: 'azureFoundry', model, metadata }],
      files: [],
      tools: [],
    },
  } as any;
}

function makeConfig(endpoint: string, model: string, metadata: Record<string, any> = {}) {
  return {
    manifest: makeManifest(model, metadata),
    credentials: { azureFoundry: { apiKey: 'k', endpoint } },
    logLevel: 'silent',
  } as any;
}

function stubResponses() {
  azureResponsesCreate.mockImplementation(async () =>
    openAIResponsesStreamFromResponse({
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  );
}

function stubChat() {
  azureChatCreate.mockImplementation(async () =>
    openAIStreamFromCompletion({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Endpoint/baseURL detection is covered in providers/__tests__/azureFoundry.test.ts
// (that file doesn't mock 'openai', so it can inspect the real client's
// .baseURL/._options — this file mocks 'openai' to assert call routing instead).

describe('AzureFoundryExecutor — reasoning-family routing (v1 mode only)', () => {
  const V1_ENDPOINT = 'https://res.services.ai.azure.com/openai/v1';

  it('routes gpt-5.6-luna to responses.create, not chat.completions, in v1 mode', async () => {
    stubResponses();
    const ex = new AzureFoundryExecutor(makeConfig(V1_ENDPOINT, 'gpt-5.6-luna', { reasoning_effort: 'medium' }));
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    expect(azureResponsesCreate).toHaveBeenCalledTimes(1);
    expect(azureChatCreate).not.toHaveBeenCalled();
    const sent = azureResponsesCreate.mock.calls[0][0];
    expect(sent.reasoning).toEqual({ effort: 'medium' });
  });

  it('keeps a reasoning-family model on Chat Completions when NOT in v1 mode (Model Inference API has no /responses)', async () => {
    stubChat();
    const ex = new AzureFoundryExecutor(makeConfig('https://res.services.ai.azure.com/api/projects/foo', 'gpt-5.6-luna'));
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    expect(azureChatCreate).toHaveBeenCalledTimes(1);
    expect(azureResponsesCreate).not.toHaveBeenCalled();
  });

  it('leaves a non-reasoning model (gpt-4o) on Chat Completions even in v1 mode', async () => {
    stubChat();
    const ex = new AzureFoundryExecutor(makeConfig(V1_ENDPOINT, 'gpt-4o'));
    await ex.invoke([{ role: 'user', content: 'hi' }] as any);

    expect(azureChatCreate).toHaveBeenCalledTimes(1);
    expect(azureResponsesCreate).not.toHaveBeenCalled();
  });

  it('flattens tools and replays tool history as function_call/function_call_output items', async () => {
    stubResponses();
    const ex = new AzureFoundryExecutor(makeConfig(V1_ENDPOINT, 'gpt-5.6-luna'));
    await ex.invoke(
      [
        { role: 'user', content: 'find x' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'search', args: { q: 'x' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"result":"ok"}' },
      ] as any,
      { tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } }] } as any
    );

    const sent = azureResponsesCreate.mock.calls[0][0];
    const fc = sent.input.find((i: any) => i.type === 'function_call');
    const out = sent.input.find((i: any) => i.type === 'function_call_output');
    expect(fc).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'search' });
    expect(out).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: '{"result":"ok"}' });
    expect(sent.tools[0]).toMatchObject({ type: 'function', name: 'search' });
    expect(sent.tools[0].function).toBeUndefined();
  });

  it('maps Responses output + usage back into InvokeResult', async () => {
    azureResponsesCreate.mockImplementation(async () =>
      openAIResponsesStreamFromResponse({
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'here you go' }] },
          { type: 'function_call', call_id: 'call_9', name: 'book', arguments: '{"when":"noon"}' },
        ],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
      })
    );
    const ex = new AzureFoundryExecutor(makeConfig(V1_ENDPOINT, 'gpt-5.6-luna'));
    const res = await ex.invoke([{ role: 'user', content: 'book noon' }] as any);

    expect(res.message.content).toBe('here you go');
    expect(res.message.tool_calls).toEqual([{ id: 'call_9', name: 'book', args: { when: 'noon' } }]);
    expect(res.usage).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    });
  });
});

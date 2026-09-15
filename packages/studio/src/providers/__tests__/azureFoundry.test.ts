/**
 * Unit tests for AzureFoundryExecutor.
 *
 * Covers what's actually unique to this adapter vs. OpenAICompatibleExecutor —
 * credential validation and client construction (endpoint → baseURL, api-key
 * header, api-version query) — plus a smoke test that the shared OpenAI-wire
 * response mapping (reasoning-model fallback) still holds through this adapter.
 */

import { describe, it, expect, vi } from 'vitest';
import AzureFoundryExecutor from '../azureFoundry.js';

function makeManifest(model = 'claude-sonnet-latest') {
  return {
    kind: 'PromptManifest',
    apiVersion: 'v2',
    spec: {
      models: [{ provider: 'azureFoundry', model }],
      files: [],
      tools: [],
    },
  } as any;
}

describe('AzureFoundryExecutor — construction', () => {
  it('throws when credentials.azureFoundry is missing', () => {
    expect(() => new AzureFoundryExecutor({ manifest: makeManifest(), credentials: {}, logLevel: 'silent' } as any))
      .toThrow('credentials.azureFoundry is required');
  });

  it('throws when apiKey is missing', () => {
    expect(() => new AzureFoundryExecutor({
      manifest: makeManifest(),
      credentials: { azureFoundry: { endpoint: 'https://x.services.ai.azure.com' } },
      logLevel: 'silent',
    } as any)).toThrow('credentials.azureFoundry.apiKey is required');
  });

  it('throws when endpoint is missing', () => {
    expect(() => new AzureFoundryExecutor({
      manifest: makeManifest(),
      credentials: { azureFoundry: { apiKey: 'sk-test' } },
      logLevel: 'silent',
    } as any)).toThrow('credentials.azureFoundry.endpoint is required');
  });

  it('builds a client scoped to the endpoint with an api-key header and api-version query, defaulting the version', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest(),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com/' } },
      logLevel: 'silent',
    } as any);
    const client = (ex as any).client;
    expect(client.baseURL).toBe('https://my-resource.services.ai.azure.com/models');
    expect(client._options.defaultHeaders['api-key']).toBe('sk-test');
    expect(client._options.defaultQuery['api-version']).toBe('2024-05-01-preview');
  });

  it('honors an explicit apiVersion override', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest(),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com', apiVersion: '2025-01-01-preview' } },
      logLevel: 'silent',
    } as any);
    expect((ex as any).client._options.defaultQuery['api-version']).toBe('2025-01-01-preview');
  });

  // v1 endpoint mode (gpt-5.x/6.x deployments only answer here — see
  // azureFoundryV1Routing.test.ts for the reasoning-family routing this
  // detection feeds). Regression coverage for the 2026-09-14 prod incident:
  // these deployments 400'd/404'd against the Model Inference API regardless
  // of api-version, and the portal's own "openai endpoint" copy-paste value
  // carries a trailing /responses or /chat/completions this adapter must
  // strip down to the true v1 baseURL.
  it('detects a bare /openai/v1 endpoint as v1 mode with no api-version query', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest('gpt-5.6-luna'),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com/openai/v1' } },
      logLevel: 'silent',
    } as any);
    const client = (ex as any).client;
    expect(client.baseURL).toBe('https://my-resource.services.ai.azure.com/openai/v1');
    expect(client._options.defaultQuery).toBeUndefined();
  });

  it('strips a /openai/v1/responses endpoint (the Foundry portal\'s copy-paste value) to the v1 baseURL', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest('gpt-5.6-luna'),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com/openai/v1/responses' } },
      logLevel: 'silent',
    } as any);
    const client = (ex as any).client;
    expect(client.baseURL).toBe('https://my-resource.services.ai.azure.com/openai/v1');
    expect(client._options.defaultQuery).toBeUndefined();
  });

  it('strips a /openai/v1/chat/completions endpoint to the v1 baseURL', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest('gpt-4o'),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com/openai/v1/chat/completions' } },
      logLevel: 'silent',
    } as any);
    const client = (ex as any).client;
    expect(client.baseURL).toBe('https://my-resource.services.ai.azure.com/openai/v1');
    expect(client._options.defaultQuery).toBeUndefined();
  });

  it('ignores a configured apiVersion in v1 mode (the v1 GA API takes no api-version param)', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest('gpt-5.6-luna'),
      credentials: {
        azureFoundry: {
          apiKey: 'sk-test',
          endpoint: 'https://my-resource.services.ai.azure.com/openai/v1',
          apiVersion: '2025-04-01',
        },
      },
      logLevel: 'silent',
    } as any);
    expect((ex as any).client._options.defaultQuery).toBeUndefined();
  });

  it('still defaults a project-scoped (non-v1) endpoint to the Model Inference API', () => {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest('llama-3'),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com/api/projects/foo' } },
      logLevel: 'silent',
    } as any);
    const client = (ex as any).client;
    expect(client.baseURL).toBe('https://my-resource.services.ai.azure.com/api/projects/foo/models');
    expect(client._options.defaultQuery['api-version']).toBe('2024-05-01-preview');
  });
});

describe('AzureFoundryExecutor — invoke() response mapping', () => {
  function makeExecutorWithStream(chunks: any[]) {
    const ex = new AzureFoundryExecutor({
      manifest: makeManifest(),
      credentials: { azureFoundry: { apiKey: 'sk-test', endpoint: 'https://my-resource.services.ai.azure.com' } },
      logLevel: 'silent',
    } as any);
    async function* gen() {
      for (const c of chunks) yield c;
    }
    (ex as any).client = { chat: { completions: { create: vi.fn(async () => gen()) } } };
    return ex;
  }

  it('returns plain text content and disjoint usage buckets on a normal turn', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from Foundry' } }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 10 } } },
    ];
    const ex = makeExecutorWithStream(chunks);
    const result = await ex.invoke([{ role: 'user', content: 'hi' }] as any);
    expect(result.message.content).toBe('Hello from Foundry');
    expect(result.usage).toEqual({
      input_tokens: 20,
      output_tokens: 12,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
    });
  });

  it('extracts tool calls in canonical {id, name, args} shape', async () => {
    const chunks = [
      {
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"foo"}' } }],
          },
        }],
      },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
    ];
    const ex = makeExecutorWithStream(chunks);
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.tool_calls).toEqual([{ id: 'call_1', name: 'lookup', args: { q: 'foo' } }]);
    expect(ex.hasToolCalls(result.message)).toBe(true);
  });

  it('recovers reasoning-model answers left in reasoning_content on a stop turn (shared fallback logic)', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'The answer is 42.' } }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 100 } },
    ];
    const ex = makeExecutorWithStream(chunks);
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.content).toBe('The answer is 42.');
  });
});

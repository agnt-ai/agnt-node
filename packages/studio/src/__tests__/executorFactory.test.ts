import { describe, it, expect, vi } from 'vitest';

// Mock all provider executors
vi.mock('../providers/anthropic.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'anthropic' })) }));
vi.mock('../providers/openai.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'openai' })) }));
vi.mock('../providers/bedrock.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'bedrock' })) }));
vi.mock('../providers/azureFoundry.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'azureFoundry' })) }));
vi.mock('../providers/google.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'google' })) }));
// DeepSeek / Together / Fireworks / DeepInfra all share the OpenAI-compatible
// executor. Mock it AND re-export the provider set the factory imports.
vi.mock('../providers/openaiCompatible.js', () => ({
  default: vi.fn().mockImplementation(() => ({ provider: 'openai-compatible' })),
  OPENAI_COMPATIBLE_PROVIDERS: new Set(['together', 'fireworks', 'deepinfra', 'deepseek']),
  OPENAI_COMPATIBLE_BASE_URLS: {},
}));

import { createExecutor } from '../executorFactory.js';
import AnthropicExecutor from '../providers/anthropic.js';
import OpenAIExecutor from '../providers/openai.js';
import BedrockExecutor from '../providers/bedrock.js';
import AzureFoundryExecutor from '../providers/azureFoundry.js';
import GoogleExecutor from '../providers/google.js';
import OpenAICompatibleExecutor from '../providers/openaiCompatible.js';

function makeManifest(provider: string) {
  return {
    spec: {
      models: [{ provider, model: 'test-model' }]
    }
  } as any;
}

describe('createExecutor', () => {
  it('throws when manifest is missing', async () => {
    await expect(createExecutor({ manifest: null as any, credentials: {} })).rejects.toThrow('manifest is required');
  });

  it('throws when models array is empty', async () => {
    await expect(createExecutor({ manifest: { spec: { models: [] } } as any, credentials: {} }))
      .rejects.toThrow('manifest.spec.models is required');
  });

  it('throws when provider is missing', async () => {
    await expect(createExecutor({ manifest: { spec: { models: [{ model: 'test' }] } } as any, credentials: {} }))
      .rejects.toThrow('manifest.spec.models[0].provider is required');
  });

  it('throws for unsupported provider', async () => {
    await expect(createExecutor({ manifest: makeManifest('unknown-llm'), credentials: {} }))
      .rejects.toThrow('Unsupported provider: unknown-llm');
  });

  it('creates Anthropic executor for provider=anthropic', async () => {
    await createExecutor({ manifest: makeManifest('anthropic'), credentials: {} });
    expect(AnthropicExecutor).toHaveBeenCalled();
  });

  it('creates Anthropic executor (case-insensitive)', async () => {
    await createExecutor({ manifest: makeManifest('Anthropic'), credentials: {} });
    expect(AnthropicExecutor).toHaveBeenCalled();
  });

  it('creates OpenAI executor for provider=openai', async () => {
    await createExecutor({ manifest: makeManifest('openai'), credentials: {} });
    expect(OpenAIExecutor).toHaveBeenCalled();
  });

  it('creates Bedrock executor for provider=bedrock', async () => {
    await createExecutor({ manifest: makeManifest('bedrock'), credentials: {} });
    expect(BedrockExecutor).toHaveBeenCalled();
  });

  it('creates Azure Foundry executor for provider=azureFoundry', async () => {
    await createExecutor({ manifest: makeManifest('azureFoundry'), credentials: {} });
    expect(AzureFoundryExecutor).toHaveBeenCalled();
  });

  it('creates Azure Foundry executor (case-insensitive)', async () => {
    await createExecutor({ manifest: makeManifest('AzureFoundry'), credentials: {} });
    expect(AzureFoundryExecutor).toHaveBeenCalled();
  });

  it('creates OpenAI-compatible executor for provider=deepseek', async () => {
    await createExecutor({ manifest: makeManifest('deepseek'), credentials: {} });
    expect(OpenAICompatibleExecutor).toHaveBeenCalled();
  });

  it('creates OpenAI-compatible executor for provider=together (Kimi/Qwen)', async () => {
    await createExecutor({ manifest: makeManifest('together'), credentials: {} });
    expect(OpenAICompatibleExecutor).toHaveBeenCalled();
  });

  it('routes an unknown provider through OpenAI-compatible when model metadata carries a baseURL', async () => {
    const manifest = { spec: { models: [{ provider: 'newhost', model: 'm', metadata: { baseURL: 'https://api.newhost.ai/v1' } }] } } as any;
    await createExecutor({ manifest, credentials: {} });
    expect(OpenAICompatibleExecutor).toHaveBeenCalled();
  });

  it('keeps native providers native even when the model config carries metadata.baseURL', async () => {
    // metadata.baseURL is the escape hatch for UNKNOWN openai-compatible hosts —
    // it must NOT divert an Anthropic/Google/Bedrock call into the OpenAI-wire
    // adapter (which would send the request in the wrong format).
    // This file has no beforeEach mock-clear, so reset before asserting not-called.
    vi.clearAllMocks();
    const anthropic = { spec: { models: [{ provider: 'anthropic', model: 'claude-x', metadata: { baseURL: 'https://x' } }] } } as any;
    await createExecutor({ manifest: anthropic, credentials: {} });
    expect(AnthropicExecutor).toHaveBeenCalled();
    expect(OpenAICompatibleExecutor).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const google = { spec: { models: [{ provider: 'gemini', model: 'g', metadata: { baseURL: 'https://x' } }] } } as any;
    await createExecutor({ manifest: google, credentials: {} });
    expect(GoogleExecutor).toHaveBeenCalled();
    expect(OpenAICompatibleExecutor).not.toHaveBeenCalled();
  });

  it('creates Google executor for provider=google', async () => {
    await createExecutor({ manifest: makeManifest('google'), credentials: {} });
    expect(GoogleExecutor).toHaveBeenCalled();
  });

  it('passes executorFactory into config so sub-executors can be created', async () => {
    await createExecutor({ manifest: makeManifest('anthropic'), credentials: {} });
    const callArg = vi.mocked(AnthropicExecutor).mock.calls.at(-1)?.[0] as any;
    expect(typeof callArg.executorFactory).toBe('function');
  });
});

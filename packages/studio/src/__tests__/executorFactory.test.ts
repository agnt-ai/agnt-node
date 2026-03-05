import { describe, it, expect, vi } from 'vitest';

// Mock all provider executors
vi.mock('../providers/anthropic.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'anthropic' })) }));
vi.mock('../providers/openai.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'openai' })) }));
vi.mock('../providers/bedrock.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'bedrock' })) }));
vi.mock('../providers/deepseek.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'deepseek' })) }));
vi.mock('../providers/google.js', () => ({ default: vi.fn().mockImplementation(() => ({ provider: 'google' })) }));

import { createExecutor } from '../executorFactory.js';
import AnthropicExecutor from '../providers/anthropic.js';
import OpenAIExecutor from '../providers/openai.js';
import BedrockExecutor from '../providers/bedrock.js';
import DeepSeekExecutor from '../providers/deepseek.js';
import GoogleExecutor from '../providers/google.js';

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

  it('creates DeepSeek executor for provider=deepseek', async () => {
    await createExecutor({ manifest: makeManifest('deepseek'), credentials: {} });
    expect(DeepSeekExecutor).toHaveBeenCalled();
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

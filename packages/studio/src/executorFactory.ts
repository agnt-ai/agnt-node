/**
 * Executor Factory
 *
 * Creates provider-specific executor instances from a v2 PromptManifest.
 * Supports: anthropic, openai, bedrock, deepseek, google
 */

import AnthropicExecutor from './providers/anthropic.js';
import OpenAIExecutor from './providers/openai.js';
import BedrockExecutor from './providers/bedrock.js';
import DeepSeekExecutor from './providers/deepseek.js';
import GoogleExecutor from './providers/google.js';
import type { BaseExecutorConfig } from './types.js';
import type BaseExecutor from './BaseExecutor.js';

export async function createExecutor(config: BaseExecutorConfig): Promise<BaseExecutor> {
  const { manifest, log = console.log } = config;

  if (!manifest) throw new Error('[executorFactory] manifest is required');

  const spec = manifest.spec;
  if (!spec?.models || spec.models.length === 0) {
    throw new Error('[executorFactory] manifest.spec.models is required');
  }

  const primaryModel = spec.models[0];
  const provider = primaryModel.provider;
  if (!provider) throw new Error('[executorFactory] manifest.spec.models[0].provider is required');

  const configWithFactory: BaseExecutorConfig = { ...config, executorFactory: createExecutor };

  switch (provider.toLowerCase()) {
    case 'anthropic':
      log(`[executorFactory] Creating Anthropic executor: ${primaryModel.model}`);
      return new AnthropicExecutor(configWithFactory);

    case 'openai':
      log(`[executorFactory] Creating OpenAI executor: ${primaryModel.model}`);
      return new OpenAIExecutor(configWithFactory);

    case 'bedrock':
      log(`[executorFactory] Creating Bedrock executor: ${primaryModel.model}`);
      return new BedrockExecutor(configWithFactory);

    case 'deepseek':
      log(`[executorFactory] Creating DeepSeek executor: ${primaryModel.model}`);
      return new DeepSeekExecutor(configWithFactory);

    case 'google':
    case 'gemini':
      log(`[executorFactory] Creating Google executor: ${primaryModel.model}`);
      return new GoogleExecutor(configWithFactory);

    default:
      throw new Error(`[executorFactory] Unsupported provider: ${provider}`);
  }
}

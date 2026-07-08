/**
 * Executor Factory
 *
 * Creates provider-specific executor instances from a v2 PromptManifest.
 * Adapter families:
 *   - anthropic         → AnthropicExecutor
 *   - openai            → OpenAIExecutor
 *   - google / gemini   → GoogleExecutor
 *   - bedrock           → BedrockExecutor
 *   - azureFoundry      → AzureFoundryExecutor
 *   - openai-compatible → OpenAICompatibleExecutor
 *       (together, fireworks, deepinfra, deepseek, and any host that speaks the
 *        OpenAI wire format — differences live in config, not code, so a new
 *        one is an AiModel row + credentials entry with no factory change.)
 */

import AnthropicExecutor from './providers/anthropic.js';
import OpenAIExecutor from './providers/openai.js';
import BedrockExecutor from './providers/bedrock.js';
import AzureFoundryExecutor from './providers/azureFoundry.js';
import OpenAICompatibleExecutor, {
  OPENAI_COMPATIBLE_PROVIDERS,
} from './providers/openaiCompatible.js';
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
  const providerKey = provider.toLowerCase();

  // Native providers first — a native provider always wins, even if its model
  // config happens to carry metadata.baseURL (that field is the escape hatch
  // for UNKNOWN openai-compatible hosts below, and must not divert an
  // Anthropic/Google/Bedrock call into the OpenAI-wire adapter).
  switch (providerKey) {
    case 'anthropic':
      log(`[executorFactory] Creating Anthropic executor: ${primaryModel.model}`);
      return new AnthropicExecutor(configWithFactory);

    case 'openai':
      log(`[executorFactory] Creating OpenAI executor: ${primaryModel.model}`);
      return new OpenAIExecutor(configWithFactory);

    case 'bedrock':
      log(`[executorFactory] Creating Bedrock executor: ${primaryModel.model}`);
      return new BedrockExecutor(configWithFactory);

    case 'azurefoundry':
      log(`[executorFactory] Creating Azure Foundry executor: ${primaryModel.model}`);
      return new AzureFoundryExecutor(configWithFactory);

    case 'google':
    case 'gemini':
      log(`[executorFactory] Creating Google executor: ${primaryModel.model}`);
      return new GoogleExecutor(configWithFactory);
  }

  // OpenAI-compatible family: known open-model hosts (together, fireworks,
  // deepinfra, deepseek), the explicit 'openai-compatible' alias, or any other
  // provider that supplies a baseURL via model metadata (config-only new
  // provider, no factory change needed).
  if (
    OPENAI_COMPATIBLE_PROVIDERS.has(providerKey) ||
    providerKey === 'openai-compatible' ||
    providerKey === 'openai_compatible' ||
    (primaryModel as any).metadata?.baseURL
  ) {
    log(`[executorFactory] Creating OpenAI-compatible executor (${providerKey}): ${primaryModel.model}`);
    return new OpenAICompatibleExecutor(configWithFactory);
  }

  throw new Error(`[executorFactory] Unsupported provider: ${provider}`);
}

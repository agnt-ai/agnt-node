/**
 * @agnt-sdk/studio
 *
 * V2 manifest-based LLM executor for Agnt prompts.
 * Supports Anthropic, OpenAI, Bedrock, DeepSeek, Google Gemini.
 */

// ── Main executor (recommended) ──────────────────────────────────────────────
export { AgntExecutor, type AgntExecutorConfig, type AgntExecuteOptions } from './AgntExecutor.js';

// ── Lower-level APIs ─────────────────────────────────────────────────────────
export { createExecutor } from './executorFactory.js';
export { default as BaseExecutor } from './BaseExecutor.js';
export { default as ImageCache } from './ImageCache.js';

// ── Provider adapters ─────────────────────────────────────────────────────────
export { default as AnthropicExecutor } from './providers/anthropic.js';
export { default as OpenAIExecutor } from './providers/openai.js';
export { default as BedrockExecutor } from './providers/bedrock.js';
export { default as DeepSeekExecutor } from './providers/deepseek.js';
export { default as GoogleExecutor } from './providers/google.js';

// ── Condition evaluation ──────────────────────────────────────────────────────
export { evaluateCondition } from './conditions.js';

// ── System tool registry ──────────────────────────────────────────────────────
export { SYSTEM_TOOL_NAMES } from './systemTools.js';

// ── API Client & Config ───────────────────────────────────────────────────────
export { AgntApiClient, type AgntApiOptions, type PulledPrompt } from './cli/utils/api.js';
export { loadConfig } from './cli/utils/config.js';

// ── V2 Types ──────────────────────────────────────────────────────────────────
export type {
  // Manifest envelope
  PromptManifestV2,
  V2Metadata,
  V2Spec,
  // Spec components
  V2VariableDef,
  V2PromptFile,
  PromptBlock,
  V2ToolDef,
  V2ModelConfig,
  DependencyRef,
  // Conditions
  Condition,
  LeafCondition,
  CompoundCondition,
  // Resolved dependencies
  ResolvedDependencies,
  ResolvedComponent,
  ResolvedAssistant,
  ResolvedSkill,
  ResolvedScenario,
  // Execution types
  ProviderCredentials,
  ToolRouter,
  ToolHandler,
  ToolCallCallback,
  ExecutionResult,
  Usage,
  Message,
  ToolCall,
  ToolResult,
  ToolDefinition,
  BaseExecutorConfig,
  TracingConfig,
  ModelPricing,
  AgntConfig
} from './types.js';

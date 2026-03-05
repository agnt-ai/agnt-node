// ─────────────────────────────────────────────────────────────────────────────
// Execution transport types (used by BaseExecutor / provider adapters)
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema object
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type?: string;
  name: string;
  args: Record<string, any>;
  source?: 'system' | 'custom'; // tagged by executor before routing
}

export interface ToolResult {
  tool_call_id: string;
  content: any;
  forceNextTool?: string;
}

export interface ProviderCredentials {
  anthropic?: {
    apiKey: string;
    dangerouslyAllowBrowser?: boolean;
  };
  openai?: {
    apiKey: string;
    dangerouslyAllowBrowser?: boolean;
  };
  bedrock?: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  deepseek?: {
    apiKey: string;
    dangerouslyAllowBrowser?: boolean;
  };
  google?: {
    apiKey: string;
    dangerouslyAllowBrowser?: boolean;
  };
}

export interface ToolHandler {
  execute: (args: any) => Promise<any>;
}

export type ToolRouter = Record<string, ToolHandler>;

export interface ToolCallCallback {
  (params: { toolCall: ToolCall; toolResponse: any }): Promise<{ abort?: boolean; pause?: boolean } | void>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalCostUSD: number;
}

export interface InvokeResult {
  message: Message;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ExecutionResult {
  ok: boolean;
  usage: Usage;
  result: any;
  messages: Message[];
  error?: string;
  paused?: boolean;
  pendingToolCall?: ToolCall;
}

export interface TracingConfig {
  enabled: boolean;
  apiUrl?: string;
  serviceKey?: string;
  promptName?: string;
  etag?: string;
  tags?: string[];
}

export interface ModelPricing {
  provider: string;
  name: string;
  inputTokensPer1M: number;
  outputTokensPer1M: number;
  currency: string;
}

export interface BaseExecutorConfig {
  manifest: PromptManifestV2;
  variables?: Record<string, any>;
  toolRouter?: ToolRouter;
  credentials: ProviderCredentials;
  messages?: Message[];
  onToolCall?: ToolCallCallback;
  log?: (message: string, ...args: any[]) => void;
  executorFactory?: (config: BaseExecutorConfig) => Promise<any>;
  imageCache?: any;
  tracing?: TracingConfig;
  files?: Array<{
    type: string;
    image_url?: { url: string };
    input_audio?: { data: string; format: string };
  }>;
  maxMessages?: number;
  initialToolChoice?: 'auto' | 'required' | 'none' | string;
}

export interface InvokeOptions {
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none' | {
    type: 'function';
    function: { name: string };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 Prompt Manifest types
// ─────────────────────────────────────────────────────────────────────────────

/** Leaf condition: variable op value */
export interface LeafCondition {
  variable: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'exists' | 'not_exists';
  value?: any;
}

/** Compound condition: AND / OR / NOT of nested conditions */
export interface CompoundCondition {
  operator: 'AND' | 'OR' | 'NOT';
  rules: Condition[];
}

export type Condition = LeafCondition | CompoundCondition;

/** Variable definition in v2 manifest */
export interface V2VariableDef {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'file';
  description?: string;
  required?: boolean;
  source?: 'caller' | 'agnt_memory' | 'agnt_chats' | 'agnt_integration' | 'system';
  enumValues?: string[];
  defaultValue?: any;
  testValues?: any[];
  condition?: Condition | null;
}

/** A single block within a PromptFile */
export interface PromptBlock {
  type: 'text' | 'heading' | 'divider' | 'variable' | 'component_ref' | 'assistant_ref' | 'skill_ref';
  order: number;
  condition?: Condition | null;
  // text / heading
  name?: string;
  content?: string;
  headingLevel?: number;
  // variable
  variableKey?: string;
  // component_ref
  componentName?: string;
  // assistant_ref
  assistantName?: string;
  // skill_ref
  skillName?: string;
  scenarioName?: string;
}

/** A PromptFile (section) in the v2 manifest */
export interface V2PromptFile {
  section: 'system' | 'messages';
  name: string;
  description?: string;
  order: number;
  condition?: Condition | null;
  blocks: PromptBlock[];
}

/** Tool definition with optional condition */
export interface V2ToolDef {
  name: string;
  description?: string;
  whenToUse?: string;
  parameters?: Record<string, any>;
  condition?: Condition | null;
  metadata?: Record<string, any>;
}

/** Model config in v2 manifest */
export interface V2ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  weight?: number;
  fallbackOrder?: number;
  condition?: Condition | null;
  metadata?: Record<string, any>;
}

/** Dependency reference (by name, not DB id) */
export interface DependencyRef {
  type: 'component' | 'assistant' | 'skill';
  name: string;
}

/** Resolved component for portability */
export interface ResolvedComponent {
  name: string;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  content?: string | null;
}

/** Resolved assistant for portability */
export interface ResolvedAssistant {
  name: string;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  content?: string | null;
  blocks?: PromptBlock[] | null;
}

/** Resolved skill scenario */
export interface ResolvedScenario {
  name: string;
  description?: string;
  content?: string;
}

/** Resolved skill for portability */
export interface ResolvedSkill {
  name: string;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  content?: string | null;
  scenarios?: ResolvedScenario[];
}

/** Resolved dependencies embedded in exported manifests */
export interface ResolvedDependencies {
  components: ResolvedComponent[];
  assistants: ResolvedAssistant[];
  skills: ResolvedSkill[];
}

/** The v2 manifest spec */
export interface V2Spec {
  routingStrategy: 'fallback' | 'random' | 'conditional' | 'conditional_with_fallback';
  enableToolCalls: boolean;
  variables: V2VariableDef[];
  files: V2PromptFile[];
  tools: V2ToolDef[];
  models: V2ModelConfig[];
  dependencies: DependencyRef[];
}

/** Top-level metadata */
export interface V2Metadata {
  name: string;
  title: string;
  description: string;
  type?: string;
  visibility?: 'private' | 'unlisted' | 'listed' | 'system';
  contentVisibility?: 'transparent' | 'opaque';
  author?: string;
  tags?: string[];
  version?: number;
  etag?: string;
  publishedAt?: string;
  createdAt?: string;
}

/** Full v2 PromptManifest envelope */
export interface PromptManifestV2 {
  $schema: 'https://agnt.ai/schemas/manifest/v2.json';
  kind: 'PromptManifest';
  apiVersion: 'v2';
  metadata: V2Metadata;
  spec: V2Spec;
  resolvedDependencies?: ResolvedDependencies;
}

// Shared config — exported from @agnt-sdk/config
export type { AgntConfig } from '@agnt-sdk/config';

/**
 * AgntExecutor
 *
 * High-level executor that loads v2 PromptManifests by address
 * (`accountSlug/promptSlug`) from the Agnt API or local files,
 * then executes them via the appropriate provider adapter.
 *
 * Usage:
 *   const executor = await AgntExecutor.create({ credentials });
 *   const result = await executor.execute('skej/contact-collector', variables, toolRouter);
 */

import { createExecutor } from './executorFactory.js';
import { AgntApiClient } from './cli/utils/api.js';
import { loadConfig } from './cli/utils/config.js';
import type {
  PromptManifestV2,
  ProviderCredentials,
  ExecutionResult,
  ToolRouter,
  ToolCallCallback,
  TracingConfig,
  AgntConfig,
  Message
} from './types.js';

export interface AgntExecutorConfig {
  credentials: ProviderCredentials;
  config?: AgntConfig;
}

export interface AgntExecuteOptions {
  onToolCall?: ToolCallCallback;
  tracing?: Pick<TracingConfig, 'enabled' | 'tags'>;
  files?: Array<{ type: string; image_url?: { url: string }; input_audio?: { data: string; format: string } }>;
  apiMode?: boolean; // override config.apiMode for this call
  initialToolChoice?: string; // force first tool choice (e.g. 'fetch_scheduling_context')
  messages?: Message[]; // resume from saved message history
}

export class AgntExecutor {
  private credentials: ProviderCredentials;
  private config: AgntConfig;
  private client: AgntApiClient;

  private constructor(credentials: ProviderCredentials, config: AgntConfig) {
    this.credentials = credentials;
    this.config = config;
    this.client = new AgntApiClient({
      apiUrl: config.apiUrl,
      serviceKey: config.serviceKey
    });
  }

  static async create(options: AgntExecutorConfig): Promise<AgntExecutor> {
    let config = options.config;
    if (!config) {
      const loaded = await loadConfig();
      if (!loaded) {
        throw new Error('No agnt.config.js found. Run: agnt init');
      }
      config = loaded;
    }
    return new AgntExecutor(options.credentials, config);
  }

  /**
   * Execute a prompt by address.
   *
   * @param address   `accountSlug/promptSlug`
   * @param variables Runtime variables
   * @param toolRouter Tool implementations
   * @param options   Optional execution options
   */
  async execute(
    address: string,
    variables: Record<string, any> = {},
    toolRouter: ToolRouter = {},
    options?: AgntExecuteOptions
  ): Promise<ExecutionResult> {
    const { accountSlug, promptSlug } = this.parseAddress(address);

    const useApi = options?.apiMode !== undefined ? options.apiMode : this.config.apiMode;

    const manifest = useApi
      ? await this.loadFromApi(accountSlug, promptSlug)
      : await this.loadFromFile(promptSlug);

    const tracingConfig: TracingConfig | undefined = options?.tracing ? {
      enabled: options.tracing.enabled,
      apiUrl: this.config.apiUrl,
      serviceKey: this.config.serviceKey,
      promptName: address,
      etag: manifest.metadata.etag,
      tags: options.tracing.tags
    } : undefined;

    const executor = await createExecutor({
      manifest,
      credentials: this.credentials,
      variables,
      toolRouter,
      maxMessages: this.config.maxMessages,
      onToolCall: options?.onToolCall,
      tracing: tracingConfig,
      files: options?.files,
      initialToolChoice: options?.initialToolChoice,
      messages: options?.messages
    });

    return executor.execute();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Loading
  // ─────────────────────────────────────────────────────────────────────────────

  private parseAddress(address: string): { accountSlug: string; promptSlug: string } {
    const parts = address.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `[AgntExecutor] Invalid prompt address: "${address}". ` +
        'Expected format: "accountSlug/promptSlug"'
      );
    }
    return { accountSlug: parts[0], promptSlug: parts[1] };
  }

  private async loadFromApi(accountSlug: string, promptSlug: string): Promise<PromptManifestV2> {
    return this.client.getManifest(accountSlug, promptSlug);
  }

  private async loadFromFile(promptSlug: string): Promise<PromptManifestV2> {
    if (typeof process === 'undefined' || !process.versions?.node) {
      throw new Error('File mode is only supported in Node.js. Use apiMode: true for browser.');
    }

    const { join, resolve } = await import('path');
    const { readFile } = await import('fs/promises');

    const filename = promptSlug.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const outputDir = resolve(this.config.outputDir);
    const filePath = join(outputDir, `${filename}.json`);

    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      // File format: { manifest: PromptManifestV2, pulledAt: ISO }
      return parsed.manifest ?? parsed;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `Prompt file not found: ${filePath}\n` +
          `Run 'agnt pull ${promptSlug}' to download it.`
        );
      }
      throw err;
    }
  }

  getConfig(): AgntConfig {
    return { ...this.config };
  }

  getClient(): AgntApiClient {
    return this.client;
  }
}

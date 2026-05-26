/**
 * AgntApiClient — HTTP client for the Agnt API
 *
 * Used by:
 *  - AgntExecutor (runtime manifest loading)
 *  - agnt pull CLI command
 */

import type { PromptManifestV2, ModelPricing } from '../../types.js';

export interface AgntApiOptions {
  apiUrl: string;
  serviceKey?: string;
}

export interface PulledPrompt {
  manifest: PromptManifestV2;
  pulledAt: string;
}

export interface PublicPromptListItem {
  name: string;
  title: string;
  description?: string;
  visibility: string;
}

export class AgntApiClient {
  private apiUrl: string;
  private serviceKey: string;

  constructor(options: AgntApiOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.serviceKey = options.serviceKey ?? '';
  }

  private async request<T>(path: string, options: RequestInit = {}, requireAuth = false): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.serviceKey || requireAuth) {
      headers['Authorization'] = `Bearer ${this.serviceKey}`;
    }

    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Agnt API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch a v2 manifest for a specific prompt.
   * Public for listed/system prompts; auth required for private/unlisted.
   */
  async getManifest(accountSlug: string, promptSlug: string): Promise<PromptManifestV2> {
    const data = await this.request<{ ok: boolean; manifest: PromptManifestV2 }>(
      `/manifests/${accountSlug}/${promptSlug}`
    );
    return data.manifest;
  }

  /**
   * Fetch the account's model pricing catalog.
   * Returns pricing for all enabled models — used by the executor to set
   * modelPricing so calculateCost() uses real rates instead of hardcoded Sonnet.
   */
  async getModels(): Promise<ModelPricing[]> {
    const data = await this.request<{ models: (ModelPricing & { modelId: string; enabled: boolean })[] }>(
      '/models',
      {},
      true // requires auth
    );
    return data.models ?? [];
  }

  /**
   * List public prompts for an account.
   */
  async listPublicPrompts(accountSlug: string): Promise<PublicPromptListItem[]> {
    const data = await this.request<{ ok: boolean; prompts: PublicPromptListItem[] }>(
      `/manifests/${accountSlug}`
    );
    return data.prompts;
  }
}

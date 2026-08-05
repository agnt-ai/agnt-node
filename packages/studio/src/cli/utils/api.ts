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

export interface RunSummary {
  id: string;
  status: string;
  assistant: string | null;
  account: { slug: string; name: string } | null;
  title: string | null;
  ownerEmail?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRun {
  task: {
    id: string;
    status: string;
    assistant: string | null;
    account: string | null;
    ownerEmail: string | null;
    title: string | null;
    createdAt: string;
    updatedAt: string;
  };
  activities: Record<string, any>[];
}

export interface ChatRun {
  chat: {
    id: string;
    status: string;
    assistant: string | null;
    account: string | null;
    title: string | null;
    lastMessageAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  activities: Record<string, any>[];
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

  /**
   * List tasks/chats with activity in a time window. Cross-tenant — requires
   * an internal (superadmin) API key. See functions/agnt-api/controllers/adminRunsController.mjs.
   */
  async listRuns(params: { since?: string; account?: string; limit?: number } = {}): Promise<{
    since: string;
    tasks: RunSummary[];
    chats: RunSummary[];
  }> {
    const query = new URLSearchParams();
    if (params.since) query.set('since', params.since);
    if (params.account) query.set('account', params.account);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.request<{ ok: boolean; since: string; tasks: RunSummary[]; chats: RunSummary[] }>(
      `/admin/runs${qs ? `?${qs}` : ''}`,
      {},
      true
    );
  }

  /**
   * Full TaskActivity timeline for one task, any tenant.
   */
  async getTaskRun(taskId: string): Promise<TaskRun> {
    const data = await this.request<{ ok: boolean; run: TaskRun }>(`/admin/runs/tasks/${taskId}`, {}, true);
    return data.run;
  }

  /**
   * Full TaskActivity timeline for one chat, any tenant.
   */
  async getChatRun(chatId: string): Promise<ChatRun> {
    const data = await this.request<{ ok: boolean; run: ChatRun }>(`/admin/runs/chats/${chatId}`, {}, true);
    return data.run;
  }
}

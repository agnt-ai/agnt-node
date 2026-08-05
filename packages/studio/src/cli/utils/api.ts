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

// Loosely typed on purpose — these mirror Task.serialize()/Chat.serialize()/
// TaskActivity.serialize(), which carry many optional fields we don't need
// to fully model for a debugging CLI. `--json` always exposes the raw shape.
export type TaskSummary = Record<string, any>;
export type ChatSummary = Record<string, any>;
export type Activity = Record<string, any>;

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
   * GET /tasks — account-scoped (an account-level API key sees every task in
   * the account; a user-scoped key sees only its own). Sorted newest-created first.
   */
  async listTasks(params: { status?: string; perPage?: number; page?: number } = {}): Promise<{
    tasks: TaskSummary[];
    total: number;
  }> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.perPage) query.set('perPage', String(params.perPage));
    if (params.page) query.set('page', String(params.page));
    const qs = query.toString();
    const data = await this.request<{ ok: boolean; tasks: TaskSummary[]; total: number }>(
      `/tasks${qs ? `?${qs}` : ''}`,
      {},
      true
    );
    return { tasks: data.tasks, total: data.total };
  }

  /**
   * GET /chats — same account-wide/user-scoped split as listTasks. Sorted by
   * lastMessageAt, newest first.
   */
  async listChats(params: { status?: string; perPage?: number; page?: number } = {}): Promise<{
    chats: ChatSummary[];
    total: number;
  }> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.perPage) query.set('perPage', String(params.perPage));
    if (params.page) query.set('page', String(params.page));
    const qs = query.toString();
    const data = await this.request<{ ok: boolean; chats: ChatSummary[]; total: number }>(
      `/chats${qs ? `?${qs}` : ''}`,
      {},
      true
    );
    return { chats: data.chats, total: data.total };
  }

  /**
   * GET /tasks/:taskId — task metadata (title, status, owner, account, etc.)
   */
  async getTask(taskId: string): Promise<TaskSummary> {
    const data = await this.request<{ ok: boolean; task: TaskSummary }>(`/tasks/${taskId}`, {}, true);
    return data.task;
  }

  /**
   * GET /chats/:chatId — chat metadata.
   */
  async getChat(chatId: string): Promise<ChatSummary> {
    const data = await this.request<{ ok: boolean; chat: ChatSummary }>(`/chats/${chatId}`, {}, true);
    return data.chat;
  }

  /**
   * GET /tasks/:taskId/activities — the full tool-call/tool-result timeline
   * (and every other activity type), paginated newest-first, cursor via `before`.
   */
  async getTaskActivities(taskId: string, params: { limit?: number; before?: string } = {}): Promise<{
    activities: Activity[];
    hasMore: boolean;
    cursor: string | null;
  }> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.before) query.set('before', params.before);
    const qs = query.toString();
    return this.request<{ ok: boolean; activities: Activity[]; hasMore: boolean; cursor: string | null }>(
      `/tasks/${taskId}/activities${qs ? `?${qs}` : ''}`,
      {},
      true
    );
  }

  /**
   * GET /chats/:chatId/activities — same cursor-pagination contract as
   * getTaskActivities (newest-first, un-reversed).
   */
  async getChatActivities(chatId: string, params: { limit?: number; before?: string } = {}): Promise<{
    activities: Activity[];
    hasMore: boolean;
    cursor: string | null;
  }> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.before) query.set('before', params.before);
    const qs = query.toString();
    return this.request<{ ok: boolean; activities: Activity[]; hasMore: boolean; cursor: string | null }>(
      `/chats/${chatId}/activities${qs ? `?${qs}` : ''}`,
      {},
      true
    );
  }
}

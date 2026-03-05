import type { HttpClient } from '../HttpClient.js';
import type {
  Assistant, CreateAssistantBody, UpdateAssistantBody, Inbox, CreateInboxBody, PagedResponse
} from '../types.js';

export class AssistantsResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Assistant[]> {
    const r = await this.http.get<any>('/assistants');
    return r.assistants;
  }

  async listSystem(): Promise<Assistant[]> {
    const r = await this.http.get<any>('/assistants/system');
    return r.assistants;
  }

  async get(assistantId: string): Promise<Assistant> {
    const r = await this.http.get<any>(`/assistants/${assistantId}`);
    return r.assistant;
  }

  async create(body: CreateAssistantBody): Promise<Assistant> {
    const r = await this.http.post<any>('/assistants', body);
    return r.assistant;
  }

  async update(assistantId: string, body: UpdateAssistantBody): Promise<Assistant> {
    const r = await this.http.put<any>(`/assistants/${assistantId}`, body);
    return r.assistant;
  }

  async delete(assistantId: string): Promise<void> {
    await this.http.delete(`/assistants/${assistantId}`);
  }

  async bulkSync(assistants: Array<{ name: string; email?: string; [key: string]: any }>): Promise<Assistant[]> {
    const r = await this.http.post<any>('/assistants/bulk-sync', { assistants });
    return r.assistants;
  }

  // ── Per-user assistant shortcuts ───────────────────────────────────────────

  forUser = {
    get: async (userId: string): Promise<Assistant> => {
      const r = await this.http.get<any>(`/users/${userId}/assistant`);
      return r.assistant;
    },
    create: async (userId: string, body: CreateAssistantBody): Promise<Assistant> => {
      const r = await this.http.post<any>(`/users/${userId}/assistant`, body);
      return r.assistant;
    },
    update: async (userId: string, body: UpdateAssistantBody): Promise<Assistant> => {
      const r = await this.http.put<any>(`/users/${userId}/assistant`, body);
      return r.assistant;
    },
    delete: async (userId: string): Promise<void> => {
      await this.http.delete(`/users/${userId}/assistant`);
    }
  };

  // ── Inbox ──────────────────────────────────────────────────────────────────

  inbox = {
    create: async (assistantId: string, body: CreateInboxBody): Promise<Inbox> => {
      const r = await this.http.post<any>(`/assistants/${assistantId}/inbox`, body);
      return r.inbox;
    },
    get: async (assistantId: string): Promise<Inbox> => {
      const r = await this.http.get<any>(`/assistants/${assistantId}/inbox`);
      return r.inbox;
    },
    delete: async (assistantId: string): Promise<void> => {
      await this.http.delete(`/assistants/${assistantId}/inbox`);
    }
  };
}

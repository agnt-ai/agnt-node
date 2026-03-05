import type { HttpClient } from '../HttpClient.js';
import type {
  Identifier, CreateIdentifierBody, Inbox, CreateInboxBody, Calendar, PagedResponse
} from '../types.js';

export class IdentifiersResource {
  constructor(private http: HttpClient) {}

  async list(params?: { type?: string; userId?: string }): Promise<PagedResponse<Identifier>> {
    const r = await this.http.get<any>('/identifiers', params as any);
    return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.identifiers };
  }

  async get(identifierId: string): Promise<Identifier> {
    const r = await this.http.get<any>(`/identifiers/${identifierId}`);
    return r.identifier;
  }

  async create(body: CreateIdentifierBody): Promise<Identifier> {
    const r = await this.http.post<any>('/identifiers', body);
    return r.identifier;
  }

  async update(identifierId: string, body: Partial<CreateIdentifierBody>): Promise<Identifier> {
    const r = await this.http.put<any>(`/identifiers/${identifierId}`, body);
    return r.identifier;
  }

  async delete(identifierId: string): Promise<void> {
    await this.http.delete(`/identifiers/${identifierId}`);
  }

  async link(identifierId: string, userId: string): Promise<Identifier> {
    const r = await this.http.post<any>(`/identifiers/${identifierId}/link`, { userId });
    return r.identifier;
  }

  async makePrimary(identifierId: string): Promise<Identifier> {
    const r = await this.http.post<any>(`/identifiers/${identifierId}/make-primary`);
    return r.identifier;
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────

  inbox = {
    create: async (identifierId: string, body: CreateInboxBody): Promise<Inbox> => {
      const r = await this.http.post<any>(`/identifiers/${identifierId}/inbox`, body);
      return r.inbox;
    },
    get: async (identifierId: string): Promise<Inbox> => {
      const r = await this.http.get<any>(`/identifiers/${identifierId}/inbox`);
      return r.inbox;
    },
    delete: async (identifierId: string): Promise<void> => {
      await this.http.delete(`/identifiers/${identifierId}/inbox`);
    }
  };

  // ── Calendars ──────────────────────────────────────────────────────────────

  calendars = {
    list: async (identifierId: string): Promise<Calendar[]> => {
      const r = await this.http.get<any>(`/identifiers/${identifierId}/calendars`);
      return r.calendars;
    },
    sync: async (identifierId: string): Promise<void> => {
      await this.http.post(`/identifiers/${identifierId}/calendars/sync`);
    }
  };

  // ── Preferences ────────────────────────────────────────────────────────────

  preferences = {
    list: async (identifierId: string): Promise<Record<string, any>> => {
      const r = await this.http.get<any>(`/identifiers/${identifierId}/preferences`);
      return r.preferences ?? r;
    },
    get: async (identifierId: string, skillName: string): Promise<Record<string, any>> => {
      const r = await this.http.get<any>(`/identifiers/${identifierId}/preferences`);
      const prefs = r.preferences ?? r;
      return prefs[skillName] ?? prefs;
    },
    set: async (identifierId: string, skillName: string, body: Record<string, any>): Promise<Record<string, any>> => {
      const r = await this.http.put<any>(`/identifiers/${identifierId}/preferences/${skillName}`, { preferences: body });
      return r.preferences ?? r;
    },
    delete: async (identifierId: string, skillName: string): Promise<void> => {
      await this.http.delete(`/identifiers/${identifierId}/preferences/${skillName}`);
    }
  };
}

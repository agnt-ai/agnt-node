import type { HttpClient } from '../HttpClient.js';
import type {
  Memory, CreateMemoryBody, UpdateMemoryBody, ListMemoriesParams, PagedResponse
} from '../types.js';

export class MemoriesResource {
  constructor(private http: HttpClient) {}

  async list(params?: ListMemoriesParams): Promise<PagedResponse<Memory>> {
    const r = await this.http.get<any>('/memories', params as any);
    return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.memories };
  }

  async get(memoryId: string): Promise<Memory> {
    const r = await this.http.get<any>(`/memories/${memoryId}`);
    return r.memory;
  }

  async create(body: CreateMemoryBody): Promise<Memory> {
    const r = await this.http.post<any>('/memories', body);
    return r.memory;
  }

  async update(memoryId: string, body: UpdateMemoryBody): Promise<Memory> {
    const r = await this.http.put<any>(`/memories/${memoryId}`, body);
    return r.memory;
  }

  async delete(memoryId: string): Promise<void> {
    await this.http.delete(`/memories/${memoryId}`);
  }
}

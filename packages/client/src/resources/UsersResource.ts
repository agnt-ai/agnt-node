import type { HttpClient } from '../HttpClient.js';
import type {
  User, CreateUserBody, UpdateUserBody, SyncUserBody, ListUsersParams, PagedResponse
} from '../types.js';

export class UsersResource {
  constructor(private http: HttpClient) {}

  async list(params?: ListUsersParams): Promise<PagedResponse<User>> {
    const r = await this.http.get<any>('/users', params as any);
    return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.users };
  }

  async get(userId: string): Promise<User> {
    const r = await this.http.get<any>(`/users/${userId}`);
    return r.user;
  }

  async create(body: CreateUserBody): Promise<User> {
    const r = await this.http.post<any>('/users', body);
    return r.user;
  }

  /**
   * Upsert a user by email — creates if not exists, updates if found.
   * Ideal for syncing users from your own system.
   */
  async sync(body: SyncUserBody): Promise<User> {
    const r = await this.http.post<any>('/users/sync', body);
    return r.user;
  }

  async update(userId: string, body: UpdateUserBody): Promise<User> {
    const r = await this.http.put<any>(`/users/${userId}`, body);
    return r.user;
  }

  async delete(userId: string): Promise<void> {
    await this.http.delete(`/users/${userId}`);
  }
}

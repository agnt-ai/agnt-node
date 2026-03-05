import type { HttpClient } from '../HttpClient.js';
import type {
  Contact, CreateContactBody, ListContactsParams, PagedResponse, BulkImportResult
} from '../types.js';

export class ContactsResource {
  constructor(private http: HttpClient) {}

  async list(params?: ListContactsParams): Promise<PagedResponse<Contact>> {
    const r = await this.http.get<any>('/contacts', params as any);
    return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.contacts };
  }

  async get(contactId: string): Promise<Contact> {
    const r = await this.http.get<any>(`/contacts/${contactId}`);
    return r.contact;
  }

  async create(body: CreateContactBody): Promise<Contact> {
    const r = await this.http.post<any>('/contacts', body);
    return r.contact;
  }

  async update(contactId: string, body: Partial<CreateContactBody>): Promise<Contact> {
    const r = await this.http.put<any>(`/contacts/${contactId}`, body);
    return r.contact;
  }

  async delete(contactId: string): Promise<void> {
    await this.http.delete(`/contacts/${contactId}`);
  }

  async bulkImport(contacts: CreateContactBody[]): Promise<BulkImportResult> {
    const r = await this.http.post<any>('/contacts/bulk-import', { contacts });
    return r.bulkImport ?? r;
  }

  async merge(contactId: string, mergeIntoId: string): Promise<Contact> {
    const r = await this.http.post<any>(`/contacts/${contactId}/merge`, { mergeIntoId });
    return r.contact;
  }
}

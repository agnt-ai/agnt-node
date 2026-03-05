import type { HttpClient } from '../HttpClient.js';
import type {
  Chat, ChatMessage, CreateChatBody, AddMessageBody,
  ListChatsParams, ProcessChatResult, PaginationParams, PagedResponse
} from '../types.js';

export class ChatsResource {
  constructor(private http: HttpClient) {}

  async list(params?: ListChatsParams): Promise<PagedResponse<Chat>> {
    const r = await this.http.get<any>('/chats', params as any);
    return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.chats };
  }

  async create(body: CreateChatBody): Promise<Chat> {
    const r = await this.http.post<any>('/chats', body);
    return r.chat;
  }

  async get(chatId: string): Promise<Chat> {
    const r = await this.http.get<any>(`/chats/${chatId}`);
    return r.chat;
  }

  async delete(chatId: string): Promise<void> {
    await this.http.delete(`/chats/${chatId}`);
  }

  async process(chatId: string, body?: { metadata?: Record<string, any> }): Promise<ProcessChatResult> {
    return this.http.post<ProcessChatResult>(`/chats/${chatId}/process`, body ?? {});
  }

  messages = {
    list: async (chatId: string, params?: PaginationParams): Promise<PagedResponse<ChatMessage>> => {
      const r = await this.http.get<any>(`/chats/${chatId}/messages`, params as any);
      return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.messages };
    },
    add: async (chatId: string, body: AddMessageBody): Promise<ChatMessage> => {
      const r = await this.http.post<any>(`/chats/${chatId}/messages`, body);
      return r.message;
    },
    get: async (chatId: string, messageId: string): Promise<ChatMessage> => {
      const r = await this.http.get<any>(`/chats/${chatId}/messages/${messageId}`);
      return r.message;
    },
    update: async (chatId: string, messageId: string, body: Partial<AddMessageBody>): Promise<ChatMessage> => {
      const r = await this.http.put<any>(`/chats/${chatId}/messages/${messageId}`, body);
      return r.message;
    },
    delete: async (chatId: string, messageId: string): Promise<void> => {
      await this.http.delete(`/chats/${chatId}/messages/${messageId}`);
    },
    clear: async (chatId: string): Promise<void> => {
      await this.http.delete(`/chats/${chatId}/messages`);
    }
  };
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatsResource } from '../../resources/ChatsResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let chats: ChatsResource;

beforeEach(() => {
  http = makeMockHttp();
  chats = new ChatsResource(http);
});

describe('ChatsResource', () => {
  describe('list()', () => {
    it('calls GET /chats and maps items from r.chats', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 1, chats: [{ id: 'c1' }] });
      const result = await chats.list();
      expect(http.get).toHaveBeenCalledWith('/chats', undefined);
      expect(result.items).toEqual([{ id: 'c1' }]);
    });

    it('passes params to GET', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 2, perPage: 10, total: 5, chats: [] });
      await chats.list({ page: 2, perPage: 10 });
      expect(http.get).toHaveBeenCalledWith('/chats', { page: 2, perPage: 10 });
    });
  });

  describe('create()', () => {
    it('calls POST /chats and returns r.chat', async () => {
      const chat = { id: 'c1', title: 'Test' };
      vi.mocked(http.post).mockResolvedValue({ chat });
      const result = await chats.create({ title: 'Test' });
      expect(http.post).toHaveBeenCalledWith('/chats', { title: 'Test' });
      expect(result).toEqual(chat);
    });
  });

  describe('get()', () => {
    it('calls GET /chats/:id and returns r.chat', async () => {
      const chat = { id: 'c1' };
      vi.mocked(http.get).mockResolvedValue({ chat });
      const result = await chats.get('c1');
      expect(http.get).toHaveBeenCalledWith('/chats/c1');
      expect(result).toEqual(chat);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /chats/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await chats.delete('c1');
      expect(http.delete).toHaveBeenCalledWith('/chats/c1');
    });
  });

  describe('process()', () => {
    it('calls POST /chats/:id/process with empty body by default', async () => {
      vi.mocked(http.post).mockResolvedValue({ response: 'ok' });
      await chats.process('c1');
      expect(http.post).toHaveBeenCalledWith('/chats/c1/process', {});
    });

    it('passes metadata when provided', async () => {
      vi.mocked(http.post).mockResolvedValue({ response: 'ok' });
      await chats.process('c1', { metadata: { key: 'val' } });
      expect(http.post).toHaveBeenCalledWith('/chats/c1/process', { metadata: { key: 'val' } });
    });
  });

  describe('messages.list()', () => {
    it('calls GET /chats/:id/messages and maps items', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 2, messages: [{ id: 'm1' }] });
      const result = await chats.messages.list('c1');
      expect(http.get).toHaveBeenCalledWith('/chats/c1/messages', undefined);
      expect(result.items).toEqual([{ id: 'm1' }]);
    });
  });

  describe('messages.add()', () => {
    it('calls POST /chats/:id/messages and returns r.message', async () => {
      const msg = { id: 'm1', role: 'user', content: 'Hello' };
      vi.mocked(http.post).mockResolvedValue({ message: msg });
      const result = await chats.messages.add('c1', { role: 'user', content: 'Hello' });
      expect(http.post).toHaveBeenCalledWith('/chats/c1/messages', { role: 'user', content: 'Hello' });
      expect(result).toEqual(msg);
    });
  });

  describe('messages.get()', () => {
    it('calls GET /chats/:chatId/messages/:messageId', async () => {
      const msg = { id: 'm1' };
      vi.mocked(http.get).mockResolvedValue({ message: msg });
      const result = await chats.messages.get('c1', 'm1');
      expect(http.get).toHaveBeenCalledWith('/chats/c1/messages/m1');
      expect(result).toEqual(msg);
    });
  });

  describe('messages.update()', () => {
    it('calls PUT /chats/:chatId/messages/:messageId', async () => {
      const msg = { id: 'm1', content: 'Updated' };
      vi.mocked(http.put).mockResolvedValue({ message: msg });
      const result = await chats.messages.update('c1', 'm1', { content: 'Updated' });
      expect(http.put).toHaveBeenCalledWith('/chats/c1/messages/m1', { content: 'Updated' });
      expect(result).toEqual(msg);
    });
  });

  describe('messages.delete()', () => {
    it('calls DELETE /chats/:chatId/messages/:messageId', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await chats.messages.delete('c1', 'm1');
      expect(http.delete).toHaveBeenCalledWith('/chats/c1/messages/m1');
    });
  });

  describe('messages.clear()', () => {
    it('calls DELETE /chats/:chatId/messages', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await chats.messages.clear('c1');
      expect(http.delete).toHaveBeenCalledWith('/chats/c1/messages');
    });
  });
});

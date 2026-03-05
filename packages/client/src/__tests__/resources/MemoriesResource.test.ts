import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoriesResource } from '../../resources/MemoriesResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let memories: MemoriesResource;

beforeEach(() => {
  http = makeMockHttp();
  memories = new MemoriesResource(http);
});

describe('MemoriesResource', () => {
  describe('list()', () => {
    it('calls GET /memories and maps items from r.memories', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 1, memories: [{ id: 'm1' }] });
      const result = await memories.list();
      expect(http.get).toHaveBeenCalledWith('/memories', undefined);
      expect(result.items).toEqual([{ id: 'm1' }]);
    });

    it('passes params to GET', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 2, perPage: 5, total: 0, memories: [] });
      await memories.list({ page: 2, perPage: 5 });
      expect(http.get).toHaveBeenCalledWith('/memories', { page: 2, perPage: 5 });
    });
  });

  describe('get()', () => {
    it('calls GET /memories/:id and returns r.memory', async () => {
      const memory = { id: 'm1', content: 'Prefers aisle seats' };
      vi.mocked(http.get).mockResolvedValue({ memory });
      const result = await memories.get('m1');
      expect(http.get).toHaveBeenCalledWith('/memories/m1');
      expect(result).toEqual(memory);
    });
  });

  describe('create()', () => {
    it('calls POST /memories and returns r.memory', async () => {
      const memory = { id: 'm1', content: 'Prefers aisle seats' };
      vi.mocked(http.post).mockResolvedValue({ memory });
      const result = await memories.create({ content: 'Prefers aisle seats' });
      expect(http.post).toHaveBeenCalledWith('/memories', { content: 'Prefers aisle seats' });
      expect(result).toEqual(memory);
    });
  });

  describe('update()', () => {
    it('calls PUT /memories/:id and returns r.memory', async () => {
      const memory = { id: 'm1', content: 'Updated content' };
      vi.mocked(http.put).mockResolvedValue({ memory });
      const result = await memories.update('m1', { content: 'Updated content' });
      expect(http.put).toHaveBeenCalledWith('/memories/m1', { content: 'Updated content' });
      expect(result).toEqual(memory);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /memories/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await memories.delete('m1');
      expect(http.delete).toHaveBeenCalledWith('/memories/m1');
    });
  });
});

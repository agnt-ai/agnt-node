import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssistantsResource } from '../../resources/AssistantsResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let assistants: AssistantsResource;

beforeEach(() => {
  http = makeMockHttp();
  assistants = new AssistantsResource(http);
});

describe('AssistantsResource', () => {
  describe('list()', () => {
    it('calls GET /assistants and returns r.assistants', async () => {
      vi.mocked(http.get).mockResolvedValue({ assistants: [{ id: 'a1' }] });
      const result = await assistants.list();
      expect(http.get).toHaveBeenCalledWith('/assistants');
      expect(result).toEqual([{ id: 'a1' }]);
    });
  });

  describe('listSystem()', () => {
    it('calls GET /assistants/system and returns r.assistants', async () => {
      vi.mocked(http.get).mockResolvedValue({ assistants: [{ id: 'sys1' }] });
      const result = await assistants.listSystem();
      expect(http.get).toHaveBeenCalledWith('/assistants/system');
      expect(result).toEqual([{ id: 'sys1' }]);
    });
  });

  describe('get()', () => {
    it('calls GET /assistants/:id and returns r.assistant', async () => {
      const assistant = { id: 'a1', name: 'travel' };
      vi.mocked(http.get).mockResolvedValue({ assistant });
      const result = await assistants.get('a1');
      expect(http.get).toHaveBeenCalledWith('/assistants/a1');
      expect(result).toEqual(assistant);
    });
  });

  describe('create()', () => {
    it('calls POST /assistants and returns r.assistant', async () => {
      const assistant = { id: 'a1', name: 'travel' };
      vi.mocked(http.post).mockResolvedValue({ assistant });
      const result = await assistants.create({ name: 'travel', email: 'travel@agnt.ai' });
      expect(http.post).toHaveBeenCalledWith('/assistants', { name: 'travel', email: 'travel@agnt.ai' });
      expect(result).toEqual(assistant);
    });
  });

  describe('update()', () => {
    it('calls PUT /assistants/:id and returns r.assistant', async () => {
      const assistant = { id: 'a1', title: 'Travel Assistant' };
      vi.mocked(http.put).mockResolvedValue({ assistant });
      const result = await assistants.update('a1', { title: 'Travel Assistant' });
      expect(http.put).toHaveBeenCalledWith('/assistants/a1', { title: 'Travel Assistant' });
      expect(result).toEqual(assistant);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /assistants/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await assistants.delete('a1');
      expect(http.delete).toHaveBeenCalledWith('/assistants/a1');
    });
  });

  describe('bulkSync()', () => {
    it('calls POST /assistants/bulk-sync and returns r.assistants', async () => {
      const list = [{ id: 'a1' }, { id: 'a2' }];
      vi.mocked(http.post).mockResolvedValue({ assistants: list });
      const result = await assistants.bulkSync([{ name: 'travel' }, { name: 'finance' }]);
      expect(http.post).toHaveBeenCalledWith('/assistants/bulk-sync', { assistants: [{ name: 'travel' }, { name: 'finance' }] });
      expect(result).toEqual(list);
    });
  });

  describe('forUser', () => {
    it('forUser.get calls GET /users/:userId/assistant', async () => {
      const assistant = { id: 'a1' };
      vi.mocked(http.get).mockResolvedValue({ assistant });
      const result = await assistants.forUser.get('u1');
      expect(http.get).toHaveBeenCalledWith('/users/u1/assistant');
      expect(result).toEqual(assistant);
    });

    it('forUser.create calls POST /users/:userId/assistant', async () => {
      const assistant = { id: 'a1' };
      vi.mocked(http.post).mockResolvedValue({ assistant });
      const result = await assistants.forUser.create('u1', { name: 'personal' });
      expect(http.post).toHaveBeenCalledWith('/users/u1/assistant', { name: 'personal' });
      expect(result).toEqual(assistant);
    });

    it('forUser.update calls PUT /users/:userId/assistant', async () => {
      const assistant = { id: 'a1', title: 'Updated' };
      vi.mocked(http.put).mockResolvedValue({ assistant });
      const result = await assistants.forUser.update('u1', { title: 'Updated' });
      expect(http.put).toHaveBeenCalledWith('/users/u1/assistant', { title: 'Updated' });
      expect(result).toEqual(assistant);
    });

    it('forUser.delete calls DELETE /users/:userId/assistant', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await assistants.forUser.delete('u1');
      expect(http.delete).toHaveBeenCalledWith('/users/u1/assistant');
    });
  });

  describe('inbox', () => {
    it('inbox.create calls POST /assistants/:id/inbox', async () => {
      const inbox = { id: 'ib1' };
      vi.mocked(http.post).mockResolvedValue({ inbox });
      const result = await assistants.inbox.create('a1', { assistant: 'travel@agnt.ai' });
      expect(http.post).toHaveBeenCalledWith('/assistants/a1/inbox', { assistant: 'travel@agnt.ai' });
      expect(result).toEqual(inbox);
    });

    it('inbox.get calls GET /assistants/:id/inbox', async () => {
      const inbox = { id: 'ib1' };
      vi.mocked(http.get).mockResolvedValue({ inbox });
      const result = await assistants.inbox.get('a1');
      expect(http.get).toHaveBeenCalledWith('/assistants/a1/inbox');
      expect(result).toEqual(inbox);
    });

    it('inbox.delete calls DELETE /assistants/:id/inbox', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await assistants.inbox.delete('a1');
      expect(http.delete).toHaveBeenCalledWith('/assistants/a1/inbox');
    });
  });
});

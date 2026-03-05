import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsersResource } from '../../resources/UsersResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let users: UsersResource;

beforeEach(() => {
  http = makeMockHttp();
  users = new UsersResource(http);
});

describe('UsersResource', () => {
  describe('list()', () => {
    it('calls GET /users and maps items from r.users', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 1, users: [{ id: 'u1' }] });
      const result = await users.list();
      expect(http.get).toHaveBeenCalledWith('/users', undefined);
      expect(result.items).toEqual([{ id: 'u1' }]);
    });

    it('passes params to GET', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 10, total: 0, users: [] });
      await users.list({ page: 1, perPage: 10 });
      expect(http.get).toHaveBeenCalledWith('/users', { page: 1, perPage: 10 });
    });
  });

  describe('get()', () => {
    it('calls GET /users/:id and returns r.user', async () => {
      const user = { id: 'u1', email: 'alice@example.com' };
      vi.mocked(http.get).mockResolvedValue({ user });
      const result = await users.get('u1');
      expect(http.get).toHaveBeenCalledWith('/users/u1');
      expect(result).toEqual(user);
    });
  });

  describe('create()', () => {
    it('calls POST /users and returns r.user', async () => {
      const user = { id: 'u1', email: 'alice@example.com' };
      vi.mocked(http.post).mockResolvedValue({ user });
      const result = await users.create({ email: 'alice@example.com' });
      expect(http.post).toHaveBeenCalledWith('/users', { email: 'alice@example.com' });
      expect(result).toEqual(user);
    });
  });

  describe('sync()', () => {
    it('calls POST /users/sync and returns r.user', async () => {
      const user = { id: 'u1', email: 'alice@example.com' };
      vi.mocked(http.post).mockResolvedValue({ user });
      const result = await users.sync({ email: 'alice@example.com', firstName: 'Alice' });
      expect(http.post).toHaveBeenCalledWith('/users/sync', { email: 'alice@example.com', firstName: 'Alice' });
      expect(result).toEqual(user);
    });
  });

  describe('update()', () => {
    it('calls PUT /users/:id and returns r.user', async () => {
      const user = { id: 'u1', firstName: 'Alice Updated' };
      vi.mocked(http.put).mockResolvedValue({ user });
      const result = await users.update('u1', { firstName: 'Alice Updated' });
      expect(http.put).toHaveBeenCalledWith('/users/u1', { firstName: 'Alice Updated' });
      expect(result).toEqual(user);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /users/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await users.delete('u1');
      expect(http.delete).toHaveBeenCalledWith('/users/u1');
    });
  });
});

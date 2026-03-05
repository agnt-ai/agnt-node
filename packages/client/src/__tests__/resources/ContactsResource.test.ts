import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactsResource } from '../../resources/ContactsResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let contacts: ContactsResource;

beforeEach(() => {
  http = makeMockHttp();
  contacts = new ContactsResource(http);
});

describe('ContactsResource', () => {
  describe('list()', () => {
    it('calls GET /contacts and maps items from r.contacts', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 1, contacts: [{ id: 'c1' }] });
      const result = await contacts.list();
      expect(http.get).toHaveBeenCalledWith('/contacts', undefined);
      expect(result.items).toEqual([{ id: 'c1' }]);
    });
  });

  describe('get()', () => {
    it('calls GET /contacts/:id and returns r.contact', async () => {
      const contact = { id: 'c1', email: 'alice@example.com' };
      vi.mocked(http.get).mockResolvedValue({ contact });
      const result = await contacts.get('c1');
      expect(http.get).toHaveBeenCalledWith('/contacts/c1');
      expect(result).toEqual(contact);
    });
  });

  describe('create()', () => {
    it('calls POST /contacts and returns r.contact', async () => {
      const contact = { id: 'c1', email: 'alice@example.com' };
      vi.mocked(http.post).mockResolvedValue({ contact });
      const result = await contacts.create({ email: 'alice@example.com', name: 'Alice' });
      expect(http.post).toHaveBeenCalledWith('/contacts', { email: 'alice@example.com', name: 'Alice' });
      expect(result).toEqual(contact);
    });
  });

  describe('update()', () => {
    it('calls PUT /contacts/:id and returns r.contact', async () => {
      const contact = { id: 'c1', name: 'Alice Updated' };
      vi.mocked(http.put).mockResolvedValue({ contact });
      const result = await contacts.update('c1', { name: 'Alice Updated' });
      expect(http.put).toHaveBeenCalledWith('/contacts/c1', { name: 'Alice Updated' });
      expect(result).toEqual(contact);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /contacts/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await contacts.delete('c1');
      expect(http.delete).toHaveBeenCalledWith('/contacts/c1');
    });
  });

  describe('bulkImport()', () => {
    it('calls POST /contacts/bulk-import with contacts array', async () => {
      vi.mocked(http.post).mockResolvedValue({ imported: 2 });
      const result = await contacts.bulkImport([
        { email: 'alice@example.com', name: 'Alice' },
        { email: 'bob@example.com', name: 'Bob' }
      ]);
      expect(http.post).toHaveBeenCalledWith('/contacts/bulk-import', {
        contacts: [
          { email: 'alice@example.com', name: 'Alice' },
          { email: 'bob@example.com', name: 'Bob' }
        ]
      });
      expect(result.imported).toBe(2);
    });
  });

  describe('merge()', () => {
    it('calls POST /contacts/:id/merge and returns r.contact', async () => {
      const contact = { id: 'c2' };
      vi.mocked(http.post).mockResolvedValue({ contact });
      const result = await contacts.merge('c1', 'c2');
      expect(http.post).toHaveBeenCalledWith('/contacts/c1/merge', { mergeIntoId: 'c2' });
      expect(result).toEqual(contact);
    });
  });
});

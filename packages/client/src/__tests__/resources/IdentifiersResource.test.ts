import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentifiersResource } from '../../resources/IdentifiersResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let identifiers: IdentifiersResource;

beforeEach(() => {
  http = makeMockHttp();
  identifiers = new IdentifiersResource(http);
});

describe('IdentifiersResource', () => {
  describe('list()', () => {
    it('calls GET /identifiers and maps items', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 1, identifiers: [{ id: 'i1' }] });
      const result = await identifiers.list();
      expect(http.get).toHaveBeenCalledWith('/identifiers', undefined);
      expect(result.items).toEqual([{ id: 'i1' }]);
    });

    it('passes type filter', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 0, identifiers: [] });
      await identifiers.list({ type: 'email' });
      expect(http.get).toHaveBeenCalledWith('/identifiers', { type: 'email' });
    });
  });

  describe('get()', () => {
    it('calls GET /identifiers/:id and returns r.identifier', async () => {
      const identifier = { id: 'i1', type: 'email' };
      vi.mocked(http.get).mockResolvedValue({ identifier });
      const result = await identifiers.get('i1');
      expect(http.get).toHaveBeenCalledWith('/identifiers/i1');
      expect(result).toEqual(identifier);
    });
  });

  describe('create()', () => {
    it('calls POST /identifiers and returns r.identifier', async () => {
      const identifier = { id: 'i1', type: 'email', value: 'alice@example.com' };
      vi.mocked(http.post).mockResolvedValue({ identifier });
      const result = await identifiers.create({ type: 'email', value: 'alice@example.com' });
      expect(http.post).toHaveBeenCalledWith('/identifiers', { type: 'email', value: 'alice@example.com' });
      expect(result).toEqual(identifier);
    });
  });

  describe('update()', () => {
    it('calls PUT /identifiers/:id and returns r.identifier', async () => {
      const identifier = { id: 'i1', value: 'new@example.com' };
      vi.mocked(http.put).mockResolvedValue({ identifier });
      const result = await identifiers.update('i1', { value: 'new@example.com' });
      expect(http.put).toHaveBeenCalledWith('/identifiers/i1', { value: 'new@example.com' });
      expect(result).toEqual(identifier);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /identifiers/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await identifiers.delete('i1');
      expect(http.delete).toHaveBeenCalledWith('/identifiers/i1');
    });
  });

  describe('link()', () => {
    it('calls POST /identifiers/:id/link with userId', async () => {
      const identifier = { id: 'i1', userId: 'u1' };
      vi.mocked(http.post).mockResolvedValue({ identifier });
      const result = await identifiers.link('i1', 'u1');
      expect(http.post).toHaveBeenCalledWith('/identifiers/i1/link', { userId: 'u1' });
      expect(result).toEqual(identifier);
    });
  });

  describe('makePrimary()', () => {
    it('calls POST /identifiers/:id/make-primary', async () => {
      const identifier = { id: 'i1', primary: true };
      vi.mocked(http.post).mockResolvedValue({ identifier });
      const result = await identifiers.makePrimary('i1');
      expect(http.post).toHaveBeenCalledWith('/identifiers/i1/make-primary');
      expect(result).toEqual(identifier);
    });
  });

  describe('inbox', () => {
    it('inbox.create calls POST /identifiers/:id/inbox', async () => {
      const inbox = { id: 'ib1' };
      vi.mocked(http.post).mockResolvedValue({ inbox });
      const result = await identifiers.inbox.create('i1', { assistant: 'travel@agnt.ai' });
      expect(http.post).toHaveBeenCalledWith('/identifiers/i1/inbox', { assistant: 'travel@agnt.ai' });
      expect(result).toEqual(inbox);
    });

    it('inbox.get calls GET /identifiers/:id/inbox', async () => {
      const inbox = { id: 'ib1' };
      vi.mocked(http.get).mockResolvedValue({ inbox });
      const result = await identifiers.inbox.get('i1');
      expect(http.get).toHaveBeenCalledWith('/identifiers/i1/inbox');
      expect(result).toEqual(inbox);
    });

    it('inbox.delete calls DELETE /identifiers/:id/inbox', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await identifiers.inbox.delete('i1');
      expect(http.delete).toHaveBeenCalledWith('/identifiers/i1/inbox');
    });
  });

  describe('calendars', () => {
    it('calendars.list calls GET /identifiers/:id/calendars and returns r.calendars', async () => {
      vi.mocked(http.get).mockResolvedValue({ calendars: [{ id: 'cal1' }] });
      const result = await identifiers.calendars.list('i1');
      expect(http.get).toHaveBeenCalledWith('/identifiers/i1/calendars');
      expect(result).toEqual([{ id: 'cal1' }]);
    });

    it('calendars.sync calls POST /identifiers/:id/calendars/sync', async () => {
      vi.mocked(http.post).mockResolvedValue({});
      await identifiers.calendars.sync('i1');
      expect(http.post).toHaveBeenCalledWith('/identifiers/i1/calendars/sync');
    });
  });

  describe('preferences', () => {
    it('preferences.list calls GET /identifiers/:id/preferences', async () => {
      vi.mocked(http.get).mockResolvedValue({ preferences: { theme: 'dark' } });
      const result = await identifiers.preferences.list('i1');
      expect(http.get).toHaveBeenCalledWith('/identifiers/i1/preferences');
      expect(result).toEqual({ theme: 'dark' });
    });

    it('preferences.get calls GET /identifiers/:id/preferences and extracts section', async () => {
      vi.mocked(http.get).mockResolvedValue({ preferences: { calendar: { timezone: 'UTC' } } });
      const result = await identifiers.preferences.get('i1', 'calendar');
      expect(http.get).toHaveBeenCalledWith('/identifiers/i1/preferences');
      expect(result).toEqual({ timezone: 'UTC' });
    });

    it('preferences.set calls PUT /identifiers/:id/preferences/:skillName with wrapped body', async () => {
      vi.mocked(http.put).mockResolvedValue({ preferences: { timezone: 'America/New_York' } });
      const result = await identifiers.preferences.set('i1', 'calendar', { timezone: 'America/New_York' });
      expect(http.put).toHaveBeenCalledWith('/identifiers/i1/preferences/calendar', { preferences: { timezone: 'America/New_York' } });
      expect(result).toEqual({ timezone: 'America/New_York' });
    });

    it('preferences.delete calls DELETE /identifiers/:id/preferences/:skillName', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await identifiers.preferences.delete('i1', 'calendar');
      expect(http.delete).toHaveBeenCalledWith('/identifiers/i1/preferences/calendar');
    });
  });
});

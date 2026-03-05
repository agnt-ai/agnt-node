import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhooksResource } from '../../resources/WebhooksResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let webhooks: WebhooksResource;

beforeEach(() => {
  http = makeMockHttp();
  webhooks = new WebhooksResource(http);
});

describe('WebhooksResource', () => {
  describe('get()', () => {
    it('calls GET /account/webhook and returns r.webhook', async () => {
      const webhook = { url: 'https://example.com/hook', events: ['task.created'] };
      vi.mocked(http.get).mockResolvedValue({ webhook });
      const result = await webhooks.get();
      expect(http.get).toHaveBeenCalledWith('/account/webhook');
      expect(result).toEqual(webhook);
    });
  });

  describe('update()', () => {
    it('calls PUT /account/webhook and returns r.webhook', async () => {
      const webhook = { url: 'https://example.com/hook', events: ['task.completed'] };
      vi.mocked(http.put).mockResolvedValue({ webhook });
      const result = await webhooks.update({ url: 'https://example.com/hook', events: ['task.completed'] });
      expect(http.put).toHaveBeenCalledWith('/account/webhook', { url: 'https://example.com/hook', events: ['task.completed'] });
      expect(result).toEqual(webhook);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /account/webhook', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await webhooks.delete();
      expect(http.delete).toHaveBeenCalledWith('/account/webhook');
    });
  });

  describe('test()', () => {
    it('calls POST /account/webhook/test and returns result', async () => {
      vi.mocked(http.post).mockResolvedValue({ sent: true });
      const result = await webhooks.test();
      expect(http.post).toHaveBeenCalledWith('/account/webhook/test');
      expect(result).toEqual({ sent: true });
    });
  });

  describe('revealSecret()', () => {
    it('calls POST /account/webhook/reveal-secret and returns secret', async () => {
      vi.mocked(http.post).mockResolvedValue({ secret: 'whsec_abc123' });
      const result = await webhooks.revealSecret();
      expect(http.post).toHaveBeenCalledWith('/account/webhook/reveal-secret');
      expect(result).toEqual({ secret: 'whsec_abc123' });
    });
  });

  describe('regenerateSecret()', () => {
    it('calls POST /account/webhook/regenerate-secret and returns new secret', async () => {
      vi.mocked(http.post).mockResolvedValue({ secret: 'whsec_new456' });
      const result = await webhooks.regenerateSecret();
      expect(http.post).toHaveBeenCalledWith('/account/webhook/regenerate-secret');
      expect(result).toEqual({ secret: 'whsec_new456' });
    });
  });

  describe('logs()', () => {
    it('calls GET /account/webhook/logs and returns r.logs', async () => {
      const logs = [{ id: 'l1', status: 200 }];
      vi.mocked(http.get).mockResolvedValue({ logs });
      const result = await webhooks.logs();
      expect(http.get).toHaveBeenCalledWith('/account/webhook/logs', undefined);
      expect(result).toEqual(logs);
    });

    it('passes pagination params', async () => {
      vi.mocked(http.get).mockResolvedValue({ logs: [] });
      await webhooks.logs({ page: 2, perPage: 10 });
      expect(http.get).toHaveBeenCalledWith('/account/webhook/logs', { page: 2, perPage: 10 });
    });
  });

  describe('incoming()', () => {
    it('calls GET /account/webhook/incoming and returns r.events', async () => {
      const events = [{ id: 'e1', type: 'task.created' }];
      vi.mocked(http.get).mockResolvedValue({ events });
      const result = await webhooks.incoming();
      expect(http.get).toHaveBeenCalledWith('/account/webhook/incoming', undefined);
      expect(result).toEqual(events);
    });
  });
});

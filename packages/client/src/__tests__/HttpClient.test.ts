import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpClient, AgntApiError } from '../HttpClient.js';

const mockToken = 'test-token';
const getToken = vi.fn().mockResolvedValue(mockToken);

function makeClient(baseUrl = 'https://api.agnt.ai') {
  return new HttpClient(baseUrl, getToken);
}

function mockFetch(status: number, body: any, isJson = true) {
  const responseBody = isJson ? JSON.stringify(body) : body;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(responseBody)
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  getToken.mockResolvedValue(mockToken);
});

describe('HttpClient', () => {
  describe('GET', () => {
    it('calls fetch with GET method and correct URL', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.get('/chats');
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.agnt.ai/chats',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('appends query params to URL', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.get('/chats', { page: 1, perPage: 20 });
      const fetchMock = vi.mocked(fetch);
      const url = (fetchMock.mock.calls[0] as any)[0] as string;
      expect(url).toContain('page=1');
      expect(url).toContain('perPage=20');
    });

    it('skips undefined/null query params', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.get('/chats', { page: undefined, perPage: null as any, status: 'open' });
      const fetchMock = vi.mocked(fetch);
      const url = (fetchMock.mock.calls[0] as any)[0] as string;
      expect(url).not.toContain('page=');
      expect(url).not.toContain('perPage=');
      expect(url).toContain('status=open');
    });

    it('strips trailing slash from base URL', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient('https://api.agnt.ai/');
      await client.get('/chats');
      const fetchMock = vi.mocked(fetch);
      const url = (fetchMock.mock.calls[0] as any)[0] as string;
      expect(url).toBe('https://api.agnt.ai/chats');
    });
  });

  describe('Authorization header', () => {
    it('includes Bearer token', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.get('/chats');
      const fetchMock = vi.mocked(fetch);
      const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
      expect((init.headers as any)['Authorization']).toBe(`Bearer ${mockToken}`);
    });

    it('calls getToken for each request', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.get('/chats');
      await client.get('/tasks');
      expect(getToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST', () => {
    it('calls fetch with POST method and serialized body', async () => {
      mockFetch(201, { ok: true });
      const client = makeClient();
      await client.post('/chats', { title: 'Test chat' });
      const fetchMock = vi.mocked(fetch);
      const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ title: 'Test chat' }));
    });

    it('posts without body when none provided', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.post('/tasks/123/stop');
      const fetchMock = vi.mocked(fetch);
      const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
    });
  });

  describe('PUT', () => {
    it('calls fetch with PUT method and serialized body', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.put('/tasks/123', { status: 'done' });
      const fetchMock = vi.mocked(fetch);
      const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ status: 'done' }));
    });
  });

  describe('DELETE', () => {
    it('calls fetch with DELETE method', async () => {
      mockFetch(200, { ok: true });
      const client = makeClient();
      await client.delete('/chats/123');
      const fetchMock = vi.mocked(fetch);
      const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
      expect(init.method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws AgntApiError on non-OK response with JSON error', async () => {
      mockFetch(404, { error: 'Chat not found', error_code: 'CHAT_NOT_FOUND' });
      const client = makeClient();
      await expect(client.get('/chats/missing')).rejects.toThrow(AgntApiError);
    });

    it('sets status on AgntApiError', async () => {
      mockFetch(404, { error: 'Not found' });
      const client = makeClient();
      try {
        await client.get('/chats/missing');
      } catch (e) {
        expect(e).toBeInstanceOf(AgntApiError);
        expect((e as AgntApiError).status).toBe(404);
      }
    });

    it('sets error_code on AgntApiError when present', async () => {
      mockFetch(422, { error: 'Validation failed', error_code: 'VALIDATION_ERROR' });
      const client = makeClient();
      try {
        await client.get('/chats/bad');
      } catch (e) {
        expect((e as AgntApiError).errorCode).toBe('VALIDATION_ERROR');
      }
    });

    it('uses raw text as message when response is not JSON', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('Internal Server Error')
      }));
      const client = makeClient();
      try {
        await client.get('/chats');
      } catch (e) {
        expect((e as AgntApiError).message).toBe('Internal Server Error');
      }
    });

    it('has name AgntApiError', async () => {
      mockFetch(400, { error: 'Bad request' });
      const client = makeClient();
      try {
        await client.post('/chats', {});
      } catch (e) {
        expect((e as AgntApiError).name).toBe('AgntApiError');
      }
    });
  });
});

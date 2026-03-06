/**
 * Client dry-run integration tests.
 *
 * Exercises the full AgntClient code path — real JWT signing with a
 * generated RSA key, only outbound fetch calls are stubbed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { AgntClient } from '../../AgntClient.js';
import type { AgntConfig } from '@agnt-sdk/config';

// ─── Generate a real RSA key pair once for all tests ─────────────────────────

let privateKey: string;
let config: AgntConfig;

beforeAll(() => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  privateKey = kp.privateKey;
  config = {
    privateKey,
    kid: 'dry-run-key',
    apiUrl: 'https://api.agnt.ai',
    serviceKey: '',
    outputDir: './agnt/prompts',
    apiMode: false
  };
});

// ─── Fetch stub helpers ───────────────────────────────────────────────────────

type RequestLog = { method: string; url: string; headers: Record<string, string>; body?: any };
const requests: RequestLog[] = [];

function stubFetch(routes: Record<string, any>) {
  // Sort patterns longest-first so specific routes win over prefix matches
  const sorted = Object.entries(routes).sort(([a], [b]) => b.length - a.length);

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method: init.method!, url, headers, body });

    for (const [pattern, responseBody] of sorted) {
      if (url.includes(pattern)) {
        return { ok: true, status: 200, json: () => Promise.resolve(responseBody), text: () => Promise.resolve(JSON.stringify(responseBody)) };
      }
    }
    return { ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }), text: () => Promise.resolve('not found') };
  }));
}

beforeEach(() => {
  requests.length = 0;
  vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lastRequest() { return requests[requests.length - 1]; }

function expectBearer(req: RequestLog) {
  expect(req.headers['Authorization']).toMatch(/^Bearer /);
}

// ─────────────────────────────────────────────────────────────────────────────
// Users (management)
// ─────────────────────────────────────────────────────────────────────────────

describe('Users (management)', () => {
  it('sync — upserts a user', async () => {
    const user = { id: 'u1', account: 'acc1', email: 'alice@example.com', name: 'Alice Smith', firstName: 'Alice', lastName: 'Smith', status: 'active', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
    stubFetch({ '/users/sync': { user } });

    const client = await AgntClient.create({ config });
    const result = await client.users.sync({ email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' });

    const req = lastRequest();
    expect(req.url).toContain('/users/sync');
    expect(req.method).toBe('POST');
    expect(req.body).toMatchObject({ email: 'alice@example.com' });
    expectBearer(req);
    expect(result).toEqual(user);
  });

  it('list — returns paged users', async () => {
    stubFetch({ '/users': { ok: true, page: 1, perPage: 20, total: 2, users: [{ id: 'u1', email: 'alice@example.com', status: 'active', createdAt: '2024-01-01T00:00:00.000Z' }, { id: 'u2', email: 'bob@example.com', status: 'active', createdAt: '2024-01-01T00:00:00.000Z' }] } });

    const client = await AgntClient.create({ config });
    const result = await client.users.list();

    expect(lastRequest().url).toContain('/users');
    expect(result.items).toHaveLength(2);
  });

  it('get — returns a user by id', async () => {
    const user = { id: 'u1', email: 'alice@example.com' };
    stubFetch({ '/users/u1': { user } });

    const client = await AgntClient.create({ config });
    const result = await client.users.get('u1');

    expect(lastRequest().url).toContain('/users/u1');
    expect(result).toEqual(user);
  });

  it('delete — sends DELETE', async () => {
    stubFetch({ '/users/u1': {} });

    const client = await AgntClient.create({ config });
    await client.users.delete('u1');

    expect(lastRequest().method).toBe('DELETE');
    expect(lastRequest().url).toContain('/users/u1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Assistants (management)
// ─────────────────────────────────────────────────────────────────────────────

describe('Assistants (management)', () => {
  it('list — returns all assistants', async () => {
    stubFetch({ '/assistants': { assistants: [{ id: 'a1', name: 'travel', email: 'travel@agnt.ai', status: 'active', isSystemTemplate: false, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }] } });

    const client = await AgntClient.create({ config });
    const result = await client.assistants.list();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('travel');
  });

  it('create — posts new assistant', async () => {
    const assistant = { id: 'a1', name: 'travel', email: 'travel@agnt.ai', status: 'active', isSystemTemplate: false, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
    stubFetch({ '/assistants': { assistant } });

    const client = await AgntClient.create({ config });
    const result = await client.assistants.create({ name: 'travel', email: 'travel@agnt.ai' });

    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().body).toMatchObject({ name: 'travel' });
    expect(result).toEqual(assistant);
  });

  it('bulkSync — syncs multiple assistants', async () => {
    const assistants = [{ id: 'a1' }, { id: 'a2' }];
    stubFetch({ '/assistants/bulk-sync': { assistants } });

    const client = await AgntClient.create({ config });
    const result = await client.assistants.bulkSync([{ name: 'travel' }, { name: 'finance' }]);

    expect(lastRequest().url).toContain('/assistants/bulk-sync');
    expect(result).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chats (delegated)
// ─────────────────────────────────────────────────────────────────────────────

describe('Chats (delegated)', () => {
  it('list — returns paged chats for user', async () => {
    stubFetch({ '/chats': { ok: true, page: 1, perPage: 20, total: 1, chats: [{ id: 'c1', title: 'Test chat' }] } });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');
    const result = await user.chats.list();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Test chat');
    expectBearer(lastRequest());
  });

  it('create → process flow', async () => {
    const chat = { id: 'c1', title: 'Book a flight' };
    stubFetch({
      '/chats': { chat },
      '/chats/c1/process': { ok: true, message: { id: 'm1', role: 'assistant', content: 'Flight booked!', timestamp: 1700000000000, platform: 'chat', to: [], cc: [] }, taskIds: [] }
    });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');

    const created = await user.chats.create({ title: 'Book a flight', assistantId: 'a1' });
    expect(created.id).toBe('c1');

    const processed = await user.chats.process(created.id);
    expect(lastRequest().url).toContain('/process');
    expect(processed.ok).toBe(true);
    expect(processed.message?.content).toBe('Flight booked!');
    expect(processed.message?.role).toBe('assistant');
    expect(processed.taskIds).toEqual([]);
  });

  it('messages.add then messages.list', async () => {
    const msg = { id: 'm1', role: 'user', content: 'Hello!' };
    stubFetch({
      '/chats/c1/messages': { ok: true, page: 1, perPage: 20, total: 1, messages: [msg], message: msg }
    });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');

    const added = await user.chats.messages.add('c1', { role: 'user', content: 'Hello!' });
    expect(added.content).toBe('Hello!');

    const listed = await user.chats.messages.list('c1');
    expect(listed.items).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (delegated)
// ─────────────────────────────────────────────────────────────────────────────

describe('Tasks (delegated)', () => {
  it('create → process → stop lifecycle', async () => {
    const task = { id: 't1', account: 'acc1', title: 'Book a flight', status: 'pending', type: 'general', order: 0, owner: { id: 'u1', type: 'user', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' }, assistant: { id: 'a1', type: 'assistant', email: 'travel@agnt.ai' }, assignees: [], followers: [], skills: [], hasWriteActions: false, plan: [], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
    stubFetch({
      '/tasks': { task },
      '/tasks/t1/process': { process: { taskId: 't1', executionId: 'e1' } },
      '/tasks/t1/stop': { task: { ...task, status: 'stopped' } }
    });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');

    const created = await user.tasks.create({ title: 'Book a flight', assistant: 'travel@agnt.ai' });
    expect(created.id).toBe('t1');

    const proc = await user.tasks.process(created.id, { message: 'Start now' });
    expect(proc.executionId).toBe('e1');

    const stopped = await user.tasks.stop(created.id);
    expect(stopped.status).toBe('stopped');
  });

  it('feedback — sends like', async () => {
    stubFetch({ '/tasks/t1/feedback': {} });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');
    await user.tasks.feedback('t1', 'like');

    expect(lastRequest().body).toEqual({ status: 'like' });
  });

  it('updateAssignees', async () => {
    stubFetch({ '/tasks/t1/assignees': { task: { id: 't1' } } });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');
    await user.tasks.updateAssignees('t1', ['bob@example.com']);

    expect(lastRequest().body).toEqual({ emails: ['bob@example.com'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memories (delegated)
// ─────────────────────────────────────────────────────────────────────────────

describe('Memories (delegated)', () => {
  it('create → list → update → delete', async () => {
    const memory = { id: 'mem1', account: 'acc1', user: 'u1', content: 'Prefers aisle seats', tags: [], source: 'manual', isActive: true, isExpired: false, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
    stubFetch({
      '/memories': { memory, ok: true, page: 1, perPage: 20, total: 1, memories: [memory] },
      '/memories/mem1': { memory: { ...memory, content: 'Updated' } }
    });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');

    const created = await user.memories.create({ content: 'Prefers aisle seats' });
    expect(created.id).toBe('mem1');

    const listed = await user.memories.list();
    expect(listed.items[0].content).toBe('Prefers aisle seats');

    const updated = await user.memories.update('mem1', { content: 'Updated' });
    expect(updated.content).toBe('Updated');

    await user.memories.delete('mem1');
    expect(lastRequest().method).toBe('DELETE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contacts (delegated)
// ─────────────────────────────────────────────────────────────────────────────

describe('Contacts (delegated)', () => {
  it('create + bulkImport', async () => {
    const contact = { id: 'con1', name: 'Bob', email: 'bob@example.com', emails: ['bob@example.com'], status: 'active', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
    const bulkImport = { success: true, total: 2, created: 2, updated: 0, skipped: 0, errors: [] };
    stubFetch({
      '/contacts': { contact },
      '/contacts/bulk-import': { ok: true, bulkImport }
    });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');

    const created = await user.contacts.create({ email: 'bob@example.com', name: 'Bob' });
    expect(created.id).toBe('con1');

    const bulk = await user.contacts.bulkImport([
      { email: 'c1@example.com', name: 'C1' },
      { email: 'c2@example.com', name: 'C2' }
    ]);
    expect(bulk.created).toBe(2);
    expect(bulk.total).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers (delegated)
// ─────────────────────────────────────────────────────────────────────────────

describe('Identifiers (delegated)', () => {
  it('create → inbox → calendars → preferences', async () => {
    const identifier = { id: 'id1', type: 'email', value: 'alice@example.com' };
    stubFetch({
      '/identifiers': { identifier, ok: true, page: 1, perPage: 20, total: 1, identifiers: [identifier] },
      '/identifiers/id1/inbox': { inbox: { id: 'ib1' } },
      '/identifiers/id1/calendars': { calendars: [{ id: 'cal1', name: 'Work' }] },
      '/identifiers/id1/preferences': { preferences: { timezone: 'UTC' } },
      '/identifiers/id1/preferences/calendar': { preferences: { timezone: 'America/New_York' } }
    });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');

    const created = await user.identifiers.create({ type: 'email', value: 'alice@example.com' });
    expect(created.id).toBe('id1');

    const inbox = await user.identifiers.inbox.create('id1', { assistant: 'travel@agnt.ai' });
    expect(inbox.id).toBe('ib1');

    const cals = await user.identifiers.calendars.list('id1');
    expect(cals[0].name).toBe('Work');

    const prefs = await user.identifiers.preferences.list('id1');
    expect(prefs.timezone).toBe('UTC');

    await user.identifiers.preferences.set('id1', 'calendar', { timezone: 'America/New_York' });
    expect(lastRequest().method).toBe('PUT');
    expect(lastRequest().body).toEqual({ preferences: { timezone: 'America/New_York' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks (management)
// ─────────────────────────────────────────────────────────────────────────────

describe('Webhooks (management)', () => {
  it('update → reveal secret → test', async () => {
    const webhook = { url: 'https://example.com/hook', events: ['task.completed'] };
    stubFetch({
      '/account/webhook': { webhook },
      '/account/webhook/reveal-secret': { secret: 'whsec_abc123' },
      '/account/webhook/test': { sent: true }
    });

    const client = await AgntClient.create({ config });

    const updated = await client.webhooks.update(webhook);
    expect(updated.url).toBe('https://example.com/hook');

    const { secret } = await client.webhooks.revealSecret();
    expect(secret).toBe('whsec_abc123');

    const { sent } = await client.webhooks.test();
    expect(sent).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT / auth behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('JWT auth', () => {
  it('management client sends JWT without email claim', async () => {
    stubFetch({ '/users': { ok: true, page: 1, perPage: 20, total: 0, users: [] } });

    const client = await AgntClient.create({ config });
    await client.users.list();

    const authHeader = lastRequest().headers['Authorization'];
    const token = authHeader.replace('Bearer ', '');
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.email).toBeUndefined();
    expect(payload.exp).toBeDefined();
  });

  it('delegated client sends JWT with email claim', async () => {
    stubFetch({ '/chats': { ok: true, page: 1, perPage: 20, total: 0, chats: [] } });

    const client = await AgntClient.create({ config });
    const user = client.as('alice@example.com');
    await user.chats.list();

    const authHeader = lastRequest().headers['Authorization'];
    const token = authHeader.replace('Bearer ', '');
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.email).toBe('alice@example.com');
  });

  it('different users get different tokens', async () => {
    stubFetch({ '/chats': { ok: true, page: 1, perPage: 20, total: 0, chats: [] } });

    const client = await AgntClient.create({ config });
    const alice = client.as('alice@example.com');
    const bob = client.as('bob@example.com');

    await alice.chats.list();
    const aliceToken = lastRequest().headers['Authorization'];

    await bob.chats.list();
    const bobToken = lastRequest().headers['Authorization'];

    expect(aliceToken).not.toBe(bobToken);
  });
});

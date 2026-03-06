/**
 * Live integration tests — hits localhost:3006.
 * Run: npm run test:live -w packages/client
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AgntClient } from '../../AgntClient.js';

const USER_EMAIL = 'anindya@skej.com';
const SECONDARY_EMAIL = 'anindya+secondary@skej.com';

let client: AgntClient;
let user: AgntClient;

let userId: string;
let primaryIdentifierId: string;
let secondaryIdentifierId: string;
let assistantId: string;
let contactId: string;
let memoryId: string;
let chatId: string;
let taskId: string;

beforeAll(async () => {
  client = await AgntClient.create();
  user = client.as(USER_EMAIL, { firstName: 'Anindya', lastName: 'Skej' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Users
// ─────────────────────────────────────────────────────────────────────────────

describe('1 · Users', () => {
  it('find existing user', async () => {
    const list = await client.users.list({ perPage: 50 });
    const found = list.items.find((u: any) => u.email === USER_EMAIL);
    expect(found).toBeDefined();
    userId = found!.id;
    console.log('  user:', userId, found!.email);
  });

  it('get user by id (includes identifiers + contacts)', async () => {
    const result = await client.users.get(userId);
    console.log('  identifiers:', (result as any).identifiers?.map((i: any) => `${i.type}:${i.value}`));
    console.log('  contacts:', (result as any).contacts?.length ?? 0);
    expect(result.id).toBe(userId);
  });

  it('update user', async () => {
    const result = await client.users.update(userId, { firstName: 'Anindya', lastName: 'Skej' });
    expect(result.id).toBe(userId);
    console.log('  updated:', result.firstName, result.lastName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Identifiers
// ─────────────────────────────────────────────────────────────────────────────

describe('2 · Identifiers', () => {
  it('list — primary email auto-provisioned on user creation', async () => {
    const result = await user.identifiers.list();
    const primary = result.items.find((i: any) => i.value === USER_EMAIL);
    expect(primary).toBeDefined();
    primaryIdentifierId = primary!.id;
    console.log('  primary identifier:', primaryIdentifierId, primary!.type, (primary as any).value);
  });

  it('get primary identifier', async () => {
    const result = await user.identifiers.get(primaryIdentifierId);
    console.log('  platforms:', Object.keys((result as any).platforms ?? {}));
    expect(result.id).toBe(primaryIdentifierId);
  });

  it('create secondary email identifier', async () => {
    try {
      const result = await user.identifiers.create({ type: 'email', value: SECONDARY_EMAIL });
      secondaryIdentifierId = result.id;
      console.log('  secondary created:', secondaryIdentifierId, (result as any).value);
      expect(secondaryIdentifierId).toBeTruthy();
    } catch (e: any) {
      if (e.message.includes('already exists')) {
        const list = await user.identifiers.list();
        const existing = list.items.find((i: any) => i.value === SECONDARY_EMAIL);
        if (existing) {
          secondaryIdentifierId = existing.id;
          console.log('  secondary already exists:', secondaryIdentifierId);
        }
      } else {
        throw e;
      }
    }
  });

  it('list preferences on primary identifier', async () => {
    const result = await user.identifiers.preferences.list(primaryIdentifierId);
    console.log('  pref keys:', Object.keys(result));
    expect(result).toBeDefined();
  });

  it('set scheduling preferences', async () => {
    try {
      const result = await user.identifiers.preferences.set(primaryIdentifierId, 'scheduling', {
        defaults: { virtual: { duration: 45 } }
      });
      console.log('  scheduling prefs set:', JSON.stringify(result));
      expect(result).toBeDefined();
    } catch (e: any) {
      console.log('  set scheduling error:', e.message);
    }
  });

  it('get scheduling preferences', async () => {
    try {
      const result = await user.identifiers.preferences.get(primaryIdentifierId, 'scheduling');
      console.log('  scheduling prefs:', JSON.stringify(result));
      expect(result).toBeDefined();
    } catch (e: any) {
      console.log('  get scheduling error:', e.message);
    }
  });

  it('delete secondary identifier', async () => {
    if (!secondaryIdentifierId) { console.log('  no secondary — skipping'); return; }
    await user.identifiers.delete(secondaryIdentifierId);
    console.log('  secondary deleted:', secondaryIdentifierId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Assistants — create one to use for chats/tasks
// ─────────────────────────────────────────────────────────────────────────────

describe('3 · Assistants', () => {
  it('list existing assistants', async () => {
    const result = await client.assistants.list();
    console.log('  count:', result.length);
    if (result.length > 0) {
      assistantId = result[0].id;
      console.log('  using existing:', assistantId, (result[0] as any).email ?? (result[0] as any).name);
    }
    expect(Array.isArray(result)).toBe(true);
  });

  it('create assistant if none exist', async () => {
    if (assistantId) { console.log('  already have assistant:', assistantId); return; }
    const result = await client.assistants.create({
      name: 'sdk-test',
      email: 'sdk-test@agnt.ai'
    });
    assistantId = result.id;
    console.log('  created assistant:', assistantId, JSON.stringify(result));
    expect(assistantId).toBeTruthy();
  });

  it('get assistant', async () => {
    const result = await client.assistants.get(assistantId);
    console.log('  assistant shape keys:', Object.keys(result));
    expect(result.id).toBe(assistantId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Contacts
// ─────────────────────────────────────────────────────────────────────────────

describe('4 · Contacts', () => {
  it('create', async () => {
    const result = await user.contacts.create({ email: 'test-contact@example.com', name: 'Test Contact' });
    contactId = result.id;
    console.log('  created:', contactId);
    expect(contactId).toBeTruthy();
  });

  it('list', async () => {
    const result = await user.contacts.list({ perPage: 10 });
    console.log('  total:', result.total);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('get', async () => {
    const result = await user.contacts.get(contactId);
    expect(result.id).toBe(contactId);
  });

  it('update', async () => {
    const result = await user.contacts.update(contactId, { name: 'Test Contact Updated' });
    expect(result.id).toBe(contactId);
    console.log('  name:', result.name ?? (result as any).name);
  });

  it('bulk import', async () => {
    const result = await user.contacts.bulkImport([
      { email: 'bulk1@example.com', name: 'Bulk One' },
      { email: 'bulk2@example.com', name: 'Bulk Two' }
    ]);
    console.log('  created:', result.created, 'updated:', result.updated);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('delete', async () => {
    await user.contacts.delete(contactId);
    console.log('  deleted:', contactId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Memories
// ─────────────────────────────────────────────────────────────────────────────

describe('5 · Memories', () => {
  it('create', async () => {
    const result = await user.memories.create({ content: 'Prefers aisle seats on flights' });
    memoryId = result.id;
    console.log('  created:', memoryId);
    expect(memoryId).toBeTruthy();
  });

  it('list', async () => {
    const result = await user.memories.list({ perPage: 10 });
    console.log('  total:', result.total);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('get', async () => {
    const result = await user.memories.get(memoryId);
    expect(result.id).toBe(memoryId);
  });

  it('update', async () => {
    const result = await user.memories.update(memoryId, { content: 'Prefers aisle, window if unavailable' });
    console.log('  updated content:', result.content ?? (result as any).content);
    expect(result.id).toBe(memoryId);
  });

  it('delete', async () => {
    await user.memories.delete(memoryId);
    console.log('  deleted:', memoryId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Chats
// ─────────────────────────────────────────────────────────────────────────────

describe('6 · Chats', () => {
  it('create', async () => {
    expect(assistantId, 'need an assistantId from section 3').toBeTruthy();
    const result = await user.chats.create({ title: 'SDK test chat', assistantId });
    chatId = result.id;
    console.log('  created:', chatId, JSON.stringify(result));
    expect(chatId).toBeTruthy();
  });

  it('list', async () => {
    const result = await user.chats.list({ perPage: 10 });
    console.log('  total:', result.total);
    expect(result).toBeDefined();
  });

  it('get', async () => {
    const result = await user.chats.get(chatId);
    expect(result.id).toBe(chatId);
  });

  it('add message', async () => {
    const result = await user.chats.messages.add(chatId, { role: 'user', content: 'Hello from SDK test' });
    console.log('  message id:', result.id);
    expect(result.id).toBeTruthy();
  });

  it('process — runs collector via @agnt-sdk/studio', async () => {
    const result = await user.chats.process(chatId);
    console.log('  process result:', JSON.stringify(result, null, 2));
    expect(result.ok).toBe(true);
    if (result.message) {
      console.log('  assistant reply:', String(result.message.content).slice(0, 120));
      console.log('  taskIds:', result.taskIds);
      expect(result.message.id).toBeTruthy();
      expect(result.message.role).toBe('assistant');
    } else {
      // suppressed / ignored path
      console.log('  suppressed:', result.suppressed, '  ignored:', result.ignored);
      console.log('  taskIds:', result.taskIds);
    }
  });

  it('list messages', async () => {
    const result = await user.chats.messages.list(chatId);
    console.log('  messages:', result.items.map((m: any) => `${m.role}: ${String(m.content).slice(0, 40)}`));
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('clear messages', async () => {
    await user.chats.messages.clear(chatId);
    console.log('  messages cleared');
  });

  it('delete', async () => {
    await user.chats.delete(chatId);
    console.log('  deleted:', chatId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Tasks
// ─────────────────────────────────────────────────────────────────────────────

describe('7 · Tasks', () => {
  it('create', async () => {
    expect(assistantId, 'need an assistantId from section 3').toBeTruthy();
    const result = await user.tasks.create({ title: 'SDK test task', assistant: assistantId });
    taskId = result.id;
    console.log('  created:', taskId, JSON.stringify(result));
    expect(taskId).toBeTruthy();
  });

  it('list', async () => {
    const result = await user.tasks.list({ perPage: 10 });
    console.log('  total:', result.total);
    expect(result).toBeDefined();
  });

  it('get', async () => {
    const result = await user.tasks.get(taskId);
    expect(result.id).toBe(taskId);
  });

  it('update', async () => {
    const result = await user.tasks.update(taskId, { title: 'SDK test task (updated)' });
    console.log('  title:', (result as any).title);
    expect(result.id).toBe(taskId);
  });

  it('feedback: like', async () => {
    await user.tasks.feedback(taskId, 'like');
    console.log('  liked');
  });

  it('feedback: remove', async () => {
    await user.tasks.feedback(taskId, null);
    console.log('  feedback removed');
  });

  it('delete', async () => {
    await user.tasks.delete(taskId);
    console.log('  deleted:', taskId);
  });
});

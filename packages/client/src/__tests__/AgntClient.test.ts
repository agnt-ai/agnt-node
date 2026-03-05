import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @agnt-sdk/config
vi.mock('@agnt-sdk/config', () => ({
  loadConfig: vi.fn()
}));

// Mock auth
vi.mock('../auth.js', () => ({
  signJwt: vi.fn().mockResolvedValue('mock.jwt.token')
}));

// Mock HttpClient
vi.mock('../HttpClient.js', () => ({
  HttpClient: vi.fn().mockImplementation(() => ({})),
  AgntApiError: class AgntApiError extends Error {}
}));

// Mock all resources
vi.mock('../resources/ChatsResource.js', () => ({ ChatsResource: vi.fn().mockImplementation(() => ({ _name: 'chats' })) }));
vi.mock('../resources/TasksResource.js', () => ({ TasksResource: vi.fn().mockImplementation(() => ({ _name: 'tasks' })) }));
vi.mock('../resources/MemoriesResource.js', () => ({ MemoriesResource: vi.fn().mockImplementation(() => ({ _name: 'memories' })) }));
vi.mock('../resources/ContactsResource.js', () => ({ ContactsResource: vi.fn().mockImplementation(() => ({ _name: 'contacts' })) }));
vi.mock('../resources/IdentifiersResource.js', () => ({ IdentifiersResource: vi.fn().mockImplementation(() => ({ _name: 'identifiers' })) }));
vi.mock('../resources/AssistantsResource.js', () => ({ AssistantsResource: vi.fn().mockImplementation(() => ({ _name: 'assistants' })) }));
vi.mock('../resources/UsersResource.js', () => ({ UsersResource: vi.fn().mockImplementation(() => ({ _name: 'users' })) }));
vi.mock('../resources/WebhooksResource.js', () => ({ WebhooksResource: vi.fn().mockImplementation(() => ({ _name: 'webhooks' })) }));

import { AgntClient } from '../AgntClient.js';
import { loadConfig } from '@agnt-sdk/config';
import type { AgntConfig } from '@agnt-sdk/config';

const baseConfig: AgntConfig = {
  privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
  kid: 'test-kid',
  apiUrl: 'https://api.agnt.ai',
  serviceKey: '',
  outputDir: './agnt/prompts',
  apiMode: false
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue(baseConfig);
});

describe('AgntClient.create()', () => {
  it('creates a management client from config file', async () => {
    const client = await AgntClient.create();
    expect(client).toBeInstanceOf(AgntClient);
    expect(loadConfig).toHaveBeenCalled();
  });

  it('uses provided config over file discovery', async () => {
    const client = await AgntClient.create({ config: baseConfig });
    expect(client).toBeInstanceOf(AgntClient);
    // loadConfig should NOT be called when config is provided
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('throws when no config is found', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(null);
    await expect(AgntClient.create()).rejects.toThrow('[AgntClient] No agnt.config.js found');
  });

  it('throws when privateKey is missing', async () => {
    const config = { ...baseConfig, privateKey: undefined };
    await expect(AgntClient.create({ config })).rejects.toThrow('config.privateKey is required');
  });

  it('throws when kid is missing', async () => {
    const config = { ...baseConfig, kid: undefined };
    await expect(AgntClient.create({ config })).rejects.toThrow('config.kid is required');
  });

  it('initializes all resource properties', async () => {
    const client = await AgntClient.create();
    expect(client.chats).toBeDefined();
    expect(client.tasks).toBeDefined();
    expect(client.memories).toBeDefined();
    expect(client.contacts).toBeDefined();
    expect(client.identifiers).toBeDefined();
    expect(client.assistants).toBeDefined();
    expect(client.users).toBeDefined();
    expect(client.webhooks).toBeDefined();
  });

  it('delegatedEmail is undefined for management client', async () => {
    const client = await AgntClient.create();
    expect(client.delegatedEmail).toBeUndefined();
  });
});

describe('AgntClient.as()', () => {
  it('returns a new client scoped to the given email', async () => {
    const mgmt = await AgntClient.create();
    const user = mgmt.as('alice@example.com');
    expect(user).toBeInstanceOf(AgntClient);
    expect(user.delegatedEmail).toBe('alice@example.com');
  });

  it('management client remains unchanged after calling as()', async () => {
    const mgmt = await AgntClient.create();
    mgmt.as('alice@example.com');
    expect(mgmt.delegatedEmail).toBeUndefined();
  });

  it('creates separate delegated clients for different users', async () => {
    const mgmt = await AgntClient.create();
    const alice = mgmt.as('alice@example.com');
    const bob = mgmt.as('bob@example.com');
    expect(alice.delegatedEmail).toBe('alice@example.com');
    expect(bob.delegatedEmail).toBe('bob@example.com');
  });

  it('accepts optional firstName and lastName', async () => {
    const mgmt = await AgntClient.create();
    // Should not throw
    const user = mgmt.as('alice@example.com', { firstName: 'Alice', lastName: 'Smith' });
    expect(user.delegatedEmail).toBe('alice@example.com');
  });
});

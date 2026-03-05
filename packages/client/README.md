# @agnt-sdk/client

Typed Node.js client for the [Agnt](https://agnt.ai) REST API.

Covers every SDK-facing resource — users, tasks, chats, memories, contacts, assistants, identifiers, webhooks — with full TypeScript types and a clean two-mode API: **management** (account-level) and **delegated** (user-scoped).

## Installation

```bash
npm install @agnt-sdk/client
```

## Configuration

Create `agnt.config.js` at your project root (the SDK walks up the directory tree to find it):

```js
// agnt.config.js
export default {
  privateKey: `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----`,
  kid: 'your-key-id',         // from the Agnt dashboard → Certificates
  apiUrl: 'https://api.agnt.ai',
};
```

Or pass config directly — useful in serverless functions where a file isn't available:

```ts
const client = await AgntClient.create({
  config: { privateKey, kid, apiUrl: 'https://api.agnt.ai' }
});
```

## Authentication

The SDK uses **RS256 certificate-based JWTs**. Generate a key pair from the Agnt dashboard under Settings → Certificates. The private key stays in your `agnt.config.js`; the public key is registered on the platform.

Two token types are issued automatically:

- **Management token** — no `email` claim, account-wide scope. Used by the top-level `client.*` resources.
- **Delegated token** — includes the user's `email` (and optional name), scoped to that user. Used by `client.as(email).*`.

Tokens are cached in-memory for their full 5-minute TTL, so creating many delegated clients is efficient.

## Usage

### Management client

```ts
import { AgntClient } from '@agnt-sdk/client';

const client = await AgntClient.create();
```

#### Users

```ts
// Upsert (sync) a user — creates if not exists, no-ops if already exists
await client.users.sync({ email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' });

// List users with pagination
const { items, total } = await client.users.list({ perPage: 50 });

// Get a single user (includes nested identifiers and contacts)
const user = await client.users.get(userId);

// Update
await client.users.update(userId, { firstName: 'Alicia' });

// Delete (also removes all identifiers, preferences, and associated data)
await client.users.delete(userId);
```

#### Assistants

```ts
// List all assistants for the account
const assistants = await client.assistants.list();

// Create
const assistant = await client.assistants.create({
  name: 'travel',
  email: 'travel@example.com',
  personality: 'Friendly and efficient travel coordinator',
});

// Bulk sync — upsert many at once
await client.assistants.bulkSync([
  { name: 'travel', email: 'travel@example.com' },
  { name: 'finance', email: 'finance@example.com' },
]);
```

### Delegated client

Switch to a user context by calling `.as(email)`. This returns a new `AgntClient` instance that signs all requests with a delegated JWT scoped to that user.

```ts
const user = client.as('alice@example.com');

// Optional: pass names so they appear in JWT and are used for auto-provisioning
const user = client.as('alice@example.com', { firstName: 'Alice', lastName: 'Smith' });
```

#### Tasks

```ts
// Create
const task = await user.tasks.create({
  title: 'Book a flight to NYC next Friday',
  assistant: assistantId,
});

// List with filters
const { items } = await user.tasks.list({ status: 'pending', perPage: 20 });

// Get, update, delete
const task = await user.tasks.get(taskId);
await user.tasks.update(taskId, { title: 'Updated title' });
await user.tasks.delete(taskId);

// Trigger execution
const { executionId } = await user.tasks.process(taskId, { message: 'Start now' });

// Stop a running execution
await user.tasks.stop(taskId);

// Feedback
await user.tasks.feedback(taskId, 'like');    // thumbs up
await user.tasks.feedback(taskId, 'dislike'); // thumbs down
await user.tasks.feedback(taskId, null);      // remove feedback
```

#### Chats

```ts
// Create a chat with an assistant
const chat = await user.chats.create({ title: 'Flight planning', assistantId });

// List
const { items } = await user.chats.list({ perPage: 10 });

// Messages
await user.chats.messages.add(chatId, { role: 'user', content: 'Find me a flight to NYC' });
const { items: messages } = await user.chats.messages.list(chatId);
await user.chats.messages.clear(chatId);

// Trigger AI processing
await user.chats.process(chatId);

// Delete
await user.chats.delete(chatId);
```

#### Memories

```ts
// Create
const memory = await user.memories.create({ content: 'Prefers aisle seats on flights' });

// List, get, update, delete
const { items } = await user.memories.list({ perPage: 50 });
await user.memories.update(memoryId, { content: 'Prefers window seats' });
await user.memories.delete(memoryId);
```

#### Contacts

```ts
// Create
const contact = await user.contacts.create({ email: 'bob@example.com', name: 'Bob Smith' });

// List with search
const { items } = await user.contacts.list({ search: 'bob', perPage: 20 });

// Update, delete
await user.contacts.update(contactId, { name: 'Robert Smith' });
await user.contacts.delete(contactId);

// Bulk import (up to 1000 contacts, upserts by email)
const result = await user.contacts.bulkImport([
  { email: 'alice@example.com', name: 'Alice' },
  { email: 'bob@example.com', name: 'Bob', company: 'Acme' },
]);
console.log(`Created: ${result.created}, Updated: ${result.updated}, Skipped: ${result.skipped}`);

// Merge two contacts
await user.contacts.merge(contactId, mergeIntoContactId);
```

#### Identifiers

An identifier is an email address (or other channel) linked to a user. A primary email identifier is automatically provisioned when a user is first synced. Additional identifiers (secondary emails) can be added manually.

```ts
// List identifiers for the current user
const { items } = await user.identifiers.list();

// Add a secondary email
const identifier = await user.identifiers.create({ type: 'email', value: 'alice+work@example.com' });

// Delete a secondary identifier (primary cannot be deleted)
await user.identifiers.delete(identifierId);

// Preferences — read and write per-skill settings
const prefs = await user.identifiers.preferences.list(identifierId);
await user.identifiers.preferences.set(identifierId, 'scheduling', {
  defaults: { virtual: { duration: 45 } }
});
const schedulingPrefs = await user.identifiers.preferences.get(identifierId, 'scheduling');
```

#### Webhooks

```ts
await client.webhooks.update({
  url: 'https://example.com/webhook',
  events: ['task.completed', 'task.failed'],
  enabled: true,
});

const { secret } = await client.webhooks.revealSecret();
await client.webhooks.test();
```

## TypeScript types

All resources expose named types from the top-level export:

```ts
import type {
  User, Task, Chat, ChatMessage,
  Contact, Memory, Assistant, Identifier,
  PagedResponse, BulkImportResult,
  CreateTaskBody, UpdateTaskBody,
  CreateChatBody, AddMessageBody,
} from '@agnt-sdk/client';
```

## Response shapes

All API responses follow a standard envelope:

```
List:     { ok: true, <resource>s: [...], page, perPage, total }
Single:   { ok: true, <resource>: { ...fields } }
Delete:   { ok: true, <resource>: { id, deleted: true } }
```

The SDK unwraps these automatically — `client.users.list()` returns `PagedResponse<User>`, not the raw envelope.

See [`docs/api-shapes.md`](../../docs/api-shapes.md) for the full serialized field reference for each resource.

## Testing

```bash
npm test                  # unit + dry-run integration tests (no server needed)
npm run test:live         # live tests against localhost:3006 (requires running API)
npm run test:coverage     # coverage report
```

The dry-run tests (`src/__tests__/integration/dryrun.test.ts`) stub all HTTP calls and use a real RSA key pair generated at runtime. They exercise the full code path including JWT signing without needing an API key.

## License

MIT

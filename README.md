# @agnt-sdk

Official Node.js SDK for the [Agnt](https://agnt.ai) platform — typed API clients, LLM executors, and shared configuration in one monorepo.

## Packages

| Package | Version | Description |
|---|---|---|
| [`@agnt-sdk/client`](./packages/client) | 0.0.1 | Typed REST client — users, tasks, chats, memories, contacts, assistants |
| [`@agnt-sdk/config`](./packages/config) | 0.0.1 | Shared config loader (`agnt.config.js`) |
| [`@agnt-sdk/studio`](./packages/studio) | 0.0.1 | V2 manifest executor + `agnt` CLI |

## Quick start

```bash
npm install @agnt-sdk/client
```

Create `agnt.config.js` at your project root:

```js
export default {
  privateKey: `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----`,
  kid: 'your-key-id',
  apiUrl: 'https://api.agnt.ai',
};
```

Then:

```ts
import { AgntClient } from '@agnt-sdk/client';

const client = await AgntClient.create();

// Management — account-level
await client.users.sync({ email: 'alice@example.com', firstName: 'Alice' });
const assistants = await client.assistants.list();

// Delegated — scoped to a specific user
const user = client.as('alice@example.com');
await user.tasks.create({ title: 'Book a flight', assistant: assistantId });
await user.memories.create({ content: 'Prefers aisle seats' });
```

## Development

```bash
npm install          # install all workspace dependencies
npm run build        # build all packages
npm test             # run all tests
```

## License

MIT

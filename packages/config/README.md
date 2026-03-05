# @agnt-sdk/config

Shared configuration loader for the `@agnt-sdk` package family.

All SDK packages read from the same `agnt.config.js` (or `agnt.config.ts`) file. This package provides the type definitions and the file-discovery logic that walks up the directory tree from `process.cwd()` until it finds the config file — the same convention used by tools like ESLint and TypeScript.

## Installation

```bash
npm install @agnt-sdk/config
```

You normally don't need to install this directly — it is a peer dependency of `@agnt-sdk/client` and `@agnt-sdk/studio`.

## Config file

Create `agnt.config.js` at the root of your project:

```js
// agnt.config.js
export default {
  // Required by @agnt-sdk/client
  privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhk...
-----END PRIVATE KEY-----`,
  kid: 'your-key-id',          // Key ID from the Agnt dashboard → Certificates

  // Required by all packages
  apiUrl: 'https://api.agnt.ai',

  // Required by @agnt-sdk/studio
  serviceKey: '',               // Optional: for private/unlisted prompts
  outputDir: './agnt/prompts',  // Where pulled manifests are saved
  apiMode: false,               // true = always fetch from API; false = use local files
};
```

## Usage

```ts
import { loadConfig } from '@agnt-sdk/config';
import type { AgntConfig } from '@agnt-sdk/config';

const config: AgntConfig = await loadConfig();
```

### Override the search path

```ts
const config = await loadConfig('/path/to/project');
```

### Pass config directly (no file needed)

All SDK packages accept an optional `config` parameter that bypasses file discovery — useful in serverless environments where a config file isn't available:

```ts
const client = await AgntClient.create({
  config: {
    privateKey: process.env.AGNT_PRIVATE_KEY,
    kid: process.env.AGNT_KID,
    apiUrl: 'https://api.agnt.ai',
  }
});
```

## `AgntConfig` type reference

```ts
interface AgntConfig {
  /** RSA private key PEM — used by @agnt-sdk/client for RS256 JWT signing */
  privateKey?: string;

  /** Key ID registered on the Agnt platform — included in JWT header */
  kid?: string;

  /** Agnt API base URL, e.g. 'https://api.agnt.ai' */
  apiUrl: string;

  /** Service key for accessing private/unlisted prompts (@agnt-sdk/studio) */
  serviceKey: string;

  /** Directory where pulled manifest files are saved (@agnt-sdk/studio) */
  outputDir: string;

  /** true = fetch manifests from API on every execution (@agnt-sdk/studio) */
  apiMode: boolean;

  /** Max messages in agent loop before throwing — prevents infinite loops */
  maxMessages?: number;
}
```

## License

MIT

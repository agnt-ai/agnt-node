# @agnt-sdk/studio

V2 manifest-native LLM executor for [Agnt](https://agnt.ai) prompts, with a CLI for pulling and running agent manifests locally.

## Installation

```bash
npm install @agnt-sdk/studio
```

For the CLI:

```bash
npm install -g @agnt-sdk/studio
agnt --help
```

## Configuration

Create `agnt.config.js` at your project root. See [`@agnt-sdk/config`](../config) for the full reference.

```js
// agnt.config.js
export default {
  privateKey: `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----`,
  kid: 'your-key-id',
  apiUrl: 'https://api.agnt.ai',
  serviceKey: '',
  outputDir: './agnt/prompts',
  apiMode: true, // false = load from local files (after agnt pull)
};
```

## CLI

### `agnt pull`

Pull one or all prompt manifests from the Agnt platform into your local `outputDir`:

```bash
# Pull a specific prompt
agnt pull myaccount/flight-planner

# Pull all public prompts for an account
agnt pull myaccount/*
```

Manifests are saved to `outputDir/accountSlug/promptSlug.json`. Set `apiMode: false` in your config to execute from these local files instead of fetching from the API on every run.

### `agnt init`

Scaffold an `agnt.config.js` in the current directory:

```bash
agnt init
```

## Programmatic use

### `AgntExecutor`

Execute a prompt by address (`accountSlug/promptSlug`). Fetches the manifest from the API or a local file depending on `apiMode`.

```ts
import { AgntExecutor } from '@agnt-sdk/studio';

const executor = await AgntExecutor.create({
  credentials: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
});

const result = await executor.execute(
  'myaccount/flight-planner',
  { destination: 'New York', departDate: '2025-06-15' },
  {
    // optional tool implementations
    get_flights: {
      execute: async (args) => { /* ... */ }
    }
  }
);

console.log(result.result);   // final output
console.log(result.messages); // full message history
console.log(result.usage);    // token usage + cost
```

### `createExecutor`

Lower-level factory — takes a V2 `PromptManifestV2` object directly:

```ts
import { createExecutor } from '@agnt-sdk/studio';

const executor = await createExecutor({
  manifest,
  credentials: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
  variables: { key: 'value' },
  toolRouter: { /* tool implementations */ },
});

const result = await executor.execute();
```

## Logging

Pass `logLevel` to control output verbosity:

```ts
const executor = await createExecutor({
  manifest,
  credentials,
  logLevel: 'debug',  // 'debug' | 'info' | 'silent'  (default: 'info')
});
```

- `'info'` — lifecycle events (model selection, tool calls)
- `'debug'` — full request/response payloads sent to the LLM
- `'silent'` — no output

## V2 Manifest format

```json
{
  "$schema": "https://agnt.ai/schemas/manifest/v2.json",
  "kind": "PromptManifest",
  "apiVersion": "v2",
  "metadata": {
    "name": "flight-planner",
    "title": "Flight Planner",
    "description": "Books flights based on user preferences."
  },
  "spec": {
    "routingStrategy": "fallback",
    "enableToolCalls": true,
    "variables": [],
    "models": [
      { "provider": "anthropic", "model": "claude-sonnet-4-5" }
    ],
    "tools": [],
    "files": [],
    "dependencies": []
  }
}
```

## Supported providers

| Provider | Credentials key |
|---|---|
| Anthropic | `credentials.anthropic.apiKey` |
| OpenAI | `credentials.openai.apiKey` |
| AWS Bedrock | `credentials.bedrock.{ region, accessKeyId, secretAccessKey }` |
| DeepSeek | `credentials.deepseek.apiKey` |
| Google Gemini | `credentials.google.apiKey` |

## License

MIT

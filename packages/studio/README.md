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
  apiMode: false,
};
```

## CLI

### `agnt pull`

Pull one or all prompt manifests from the Agnt platform into your local `outputDir`:

```bash
# Pull a specific prompt
agnt pull myaccount/flight-planner

# Pull all prompts for an account
agnt pull myaccount/*
```

### `agnt init`

Scaffold an `agnt.config.js` in the current directory:

```bash
agnt init
```

## Programmatic use

### `AgntExecutor`

Execute a prompt by account/prompt slug. Fetches the manifest from the API or local file depending on `apiMode`.

```ts
import { AgntExecutor } from '@agnt-sdk/studio';

const executor = await AgntExecutor.create('myaccount/flight-planner');

const result = await executor.run({
  variables: {
    destination: 'New York',
    departDate: '2025-06-15',
  }
});

console.log(result.output);
```

### `BaseExecutor`

Lower-level executor — takes a V2 `PromptManifest` object directly:

```ts
import { BaseExecutor } from '@agnt-sdk/studio';
import type { PromptManifest } from '@agnt-sdk/studio';

const manifest: PromptManifest = { /* ... */ };
const executor = new BaseExecutor(manifest, config);
const result = await executor.run({ variables: { key: 'value' } });
```

## V2 Manifest format

```json
{
  "$schema": "https://agnt.ai/schemas/prompt-manifest/v2.json",
  "kind": "PromptManifest",
  "apiVersion": "v2",
  "metadata": {
    "name": "flight-planner",
    "account": "myaccount"
  },
  "spec": {
    "routingStrategy": "sequential",
    "enableToolCalls": true,
    "variables": [],
    "models": [],
    "tools": [],
    "dependencies": []
  }
}
```

## Supported LLM providers

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| AWS Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Google Gemini | `GOOGLE_API_KEY` |

## License

MIT

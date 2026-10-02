# @agnt-sdk/studio

V2 manifest-native LLM executor for [Agnt](https://agnt.ai) prompts, with a CLI for pulling/running agent manifests locally and for pulling task/chat run detail from the platform for debugging.

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

### `agnt configure` / `agnt run` — pull task/chat run detail from the DB

For debugging what an agent actually did on a task or chat — every tool call and result, not just the message transcript — without tunneling into the database or scraping logs. Uses the standard `/tasks` and `/chats` API, so it needs a real API key, not the project-level `agnt.config.js`.

**Setup — mint an API key, then save it as a named profile** (AWS-CLI style; profiles live in `~/.agnt/credentials`, independent of any project):

```bash
agnt configure --profile production --api-url https://api.agnt.ai --api-key ak_live_...
agnt configure --profile staging --api-url https://staging-api.agnt.ai --api-key ak_live_...
```

Select a profile per command with `--profile`, or set `AGNT_PROFILE` in your shell. Defaults to a profile named `default`.

```bash
# List recent tasks/chats
agnt run list --since 24h --profile production
agnt run list --status active --profile production

# Full activity timeline for one task/chat (tool calls + results, paginates
# through everything automatically — capped at 1000 activities by default)
agnt run task <taskId> --profile production
agnt run chat <chatId> --profile production

# No cap — fetch every activity, however many pages that takes
agnt run task <taskId> --all --profile production

# Raw JSON for piping into other tools (e.g. `jq`, or Claude Code via Bash)
agnt run task <taskId> --json --profile production
```

An account-level API key (one created without a specific `userId`) sees everything in its account. A user-scoped key only sees that one user's own tasks/chats.

### `agnt eval` — read Run Review evaluations

Run Review scores finished runs from the user's point of view (did they get what they asked for, how did it feel) and is what agnt-console's Evaluation page shows. `agnt eval` puts the same three views in the terminal, so an agent can go from "how are runs doing" to one evaluation to the run behind it. Same profile setup as `agnt run`, but it **needs an account-level API key** (one created without a user and without an org): an evaluation is a cross-user view, so a key tied to a user or an org is refused. A key's scopes are not checked: nothing enforces them on any route, and every key the console mints carries some.

```bash
# How runs are doing: averages, outcome and ending buckets, and the by-task-type table
agnt eval summary --days 30

# The evaluations, worst first. Filter to a task type from the table above,
# an outcome, how the user ended, or a score range
agnt eval list --task-class schedule_meeting_multi_participant
agnt eval list --max-score 2 --outcome failed --sort newest
agnt eval list --unclassified
agnt eval list --page 2

# One evaluation in full
agnt eval get <reviewId>

# Raw JSON for piping into other tools
agnt eval list --max-score 2 --json
```

Every review names the task and chat it is about, in full. `agnt eval get` prints the commands that follow it to the run: `agnt run task <taskId>` for the tool-call timeline, `agnt run chat <chatId>` for the conversation, and the LangSmith query for the trace.

### `agnt workflow` — push, pull and list workflow skills

Keep a workflow (a Skill with `kind: "workflow"`) in git as a JSON file. Uses the same routes as the console (`POST /skills`, `PATCH /skills/:id`), so triggers are stamped and the workflow is scheduled; it does not use the manifest import route.

```bash
agnt workflow list [--json]
agnt workflow pull daily-digest -o daily-digest.json    # omit -o to print to stdout
agnt workflow push daily-digest.json                    # create; fails if the name exists
agnt workflow push daily-digest.json --update           # update in place (name cannot change)
# all accept --profile <name>
```

Example definition (`kind` defaults to `workflow`; `name` is a lowercase slug):

```json
{
  "name": "daily-digest",
  "title": "Daily digest",
  "description": "Summarise the day each morning",
  "scheduleType": "trigger-based",
  "workflowStatus": "active",
  "hidden": false,
  "triggers": [{ "on": "cron", "schedule": "0 9 * * *" }]
}
```

Server-managed fields (`id`, `origin`, `tier`, `createdBy`, `account`, `followers`, `billedTo`, `triggerSources`, timestamps, run counters) are dropped on pull and ignored on push.

**Known limits (verified against staging, 2026-09-29)**

- `list`, `pull` and create-`push` work with an API key. A created workflow round-trips through `pull` (the server adds trigger `_id`, `intelligenceTier` and `subTriggers`).
- `push --update` was refused by the API with `403 You can only edit skills you own` on a workflow the same key had just created. Until the backend accepts it, change an existing workflow in the console.
- `userFacingPlan` is accepted on update but dropped on create (it is missing from the create schema), so it comes back `null` after a first `push`.
- `user.*` system triggers can only be created from the console.
- A user-scoped key cannot see hidden or draft skills in `list`; use an account-level key for those.
- `workflowStatus` is honoured on create (verified on staging: `"paused"` comes back `"disabled"` and is not scheduled). `status`, `followers`, `silentOnNoOp`, `processingBufferMs` and `skillCollection` are, however, ignored on create (a warning is printed when they are non-default).
- `list` shows one row per install, so a workflow installed more than once can appear twice; this comes from `GET /skills`, not the CLI.

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

## Failure results

A failed `execute()` returns `{ ok: false, error, failure }`. `error` is the message string (unchanged);
`failure` is structured, derived from the provider's typed error (HTTP status, error class, machine code) and
never from message text, so it is language-independent:

```ts
if (!result.ok) {
  const { kind, status, provider, model, fallbackTrail, retryable } = result.failure!;
  // kind: 'quota' | 'timeout' | 'aborted' | 'unsupported' | 'auth' | 'provider_error' | 'bad_request' | 'unknown'
  // fallbackTrail: [{ provider, model, kind, status }] — every model-chain member tried, in order
}
```

- `quota`: HTTP 429, or a quota/rate-limit class/code (OpenAI/Azure Foundry `rate_limit_exceeded`, `insufficient_quota`,
  `RateLimitReached`; Anthropic `rate_limit_error`; Kimi `exceeded_current_quota_error`; Google `RESOURCE_EXHAUSTED`;
  Bedrock `ThrottlingException`). Quota is checked before timeout. **Quota may be permanent**: `insufficient_quota` and
  `exceeded_current_quota_error` are `quota` with `retryable: false`.
- `timeout`: idle/backstop stream abort, HTTP 408, timeout error class or code (Node codes are read through `.cause`,
  so `fetch failed` TypeErrors classify). `aborted`: the caller stopped the run.
- `unsupported`: HTTP 501/405/415 or an `unsupported_*`/`DeploymentNotFound` style code; also a chain member that was
  skipped in the trail because no `executorFactory` could build it.
- `auth`: 401/403, `AuthenticationError`/`PermissionDeniedError`, AccessDenied codes (a revoked key is not a bad request).
- `provider_error`: 5xx (including 529 overloaded), network failures. TLS/certificate errors stay `unknown`.
- `bad_request`: any other 4xx. A 402 with no code is `bad_request`; a 402 carrying a quota code is `quota`.
- `unknown`: no typed signal, **and every error that did not come through the model chain** (a tool handler's
  rethrown error, a variable-validation error): a tool error's `.status` says nothing about the LLM provider.

**`kind` is not a retry instruction.** Use `retryable` (true for 5xx/529, transient 429, timeouts; false for permanent
quota, auth, unsupported, bad_request; absent for `unknown`).

The SDK deliberately does NOT match message text. A transient failure a provider reports only in prose (for example
Azure's "no deployments ready", an HTTP 400 with no code) is `bad_request`; a consumer that needs to catch it must do
its own text match.

Because a 429 is retried by the provider client, `streamWithRetry`, and then the next chain member, a 429 storm
often ends as a `timeout` whose `fallbackTrail` shows only `quota` entries. Inspect the trail, not just `kind`.

On success, a result has `fallbackTrail` (same entry shape) only when at least one earlier member failed, so a
quota-then-success is visible. A cancel that does not throw returns `ok: false` with no `failure`.

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

### Native reasoning replay and observation

Provider `invoke()` results can carry `message.nativeState` with the producing
provider, model, wire format and complete ordered native output items. Persist
this envelope unchanged when resuming an unfinished tool exchange. The compatible
adapter replays it once instead of reconstructing a second copy of the assistant
text and calls. OpenAI and Azure Responses preserve IDs, phase, summaries and
opaque encrypted content; Gemini preserves signed parts on tool and final-answer
turns; Anthropic preserves the complete content block order. Compatibility is
conservatively exact provider/model/format. It does not promise cross-model or
cross-provider portability. Older `rawParts` snapshots still work for recognizable
Anthropic/Gemini shapes; an incompatible envelope never falls back to those parts.

`message.reasoningSummary` contains only supported public summary text, separate
from the answer. Summary collection remains opt-in through the provider's settings
(`reasoning.summary`, `thinking.display`, or `includeThoughts`). No setting exposes
a universal raw reasoning transcript. Opaque state and legacy signed parts are
excluded from SDK traces and `llm_output` hook payloads. Traces report state
presence, public summaries, actual constructed `reasoningConfig` settings and
provider-reported reasoning counts. A missing count is unknown; zero is retained.
The count is a detail of inclusive output usage, not an extra billing bucket.

Gemini's generic `reasoning_effort` mapping applies only to supported model
families. Generate Content Gemini 3 uses supported `thinkingLevel` values;
Gemini 2.5 uses SDK budget choices of 1024/8192/16384 for low/medium/high within the
provider's ranges. `none` maps to budget zero only on 2.5 Flash, where disabling
thinking is supported. Explicit native budgets or levels win. Unsupported tiers,
unknown models and specialized image/audio/live models keep their native defaults.

Anthropic manual thinking drops incompatible forced tool choices, temperature,
and top_k; top_p is retained only within 0.95–1. Supported adaptive models retain
forced tool choices, except models that reject all forcing. The exported
`anthropicSupportsForcedTools(model, thinking)` predicate uses the actual request
thinking mode. Requested `thinking.display` and `thinking.block_binding` survive
effort translation.

New Anthropic models also bind thinking to the system prompt, tool definitions and
conversation prefix. Exact model provenance alone does not prove that a replayed
block is valid after a prefix edit. The adapter retries the exact documented
prefix-binding 400 once with the provider's `drop_block` policy and the
`thinking-binding-controls-2026-08-01` beta header, when adaptive thinking is
compatible. This is degraded recovery: stale reasoning can be dropped by the
provider. It does not restore continuity lost through a prefix edit. Generic or
tampered signature errors and unsupported thinking modes are not retried this way.
An explicit caller `error` or `drop_block` policy takes precedence. A successful
recovery is logged, traced as `prefixBindingRecovery`, and retained in the
compatible `nativeState.replayPolicy` for checkpoint resume and in the executor
instance for subsequent requests. `inputTransformations` reports the provider's
block paths/types/reasons without opaque contents.

To observe prefix mismatch reports without selecting a new policy, set
`metadata.anthropic_beta` to `['thinking-binding-controls-2026-08-01']`. This maps
to the header, and alone leaves the provider's existing mismatch behavior intact.
Existing beta values are merged during recovery. Preserving reasoning across
compaction and changing lazy tools requires preserving the valid prefix or using
the provider's server-side context editing; that broader harness policy is not
implemented by this SDK replay envelope.

Sources: [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning),
[Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking),
[Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking),
[Gemini Generate Content thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking),
[Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

The adapter reconciles canonical tool-call ID repairs, call removals/additions and
visible content edits with stored native output. Unedited items retain their exact
order, IDs, phases, argument spelling and opaque values. Removed function calls
are not replayed, repaired IDs match their results, and added calls appear once.
Such edits can still degrade provider continuity. For a compatible Gemini native
turn, if a signed function call's arguments changed, or a removed signed call
leaves an unsigned survivor, only the affected reconstructed call uses Gemini's
documented imported-history `skip_thought_signature_validator` sentinel. Traces
report `inputTransformations` with `type: imported_history` and
`reason: canonical_tool_history_changed`; an unchanged turn uses its original
signature. Recognizable legacy Gemini parts use the same reconciliation. Gemini's
preexisting function-name IDs are not unique routing IDs; the adapter matches
arguments before pairing duplicate names and never transfers another call's
signature to a surviving sibling. Cross-model/provider fallback into an ongoing
signed tool exchange can still need a restarted or explicitly imported history.
Automatic Anthropic prefix recovery in this release is bounded to adaptive/default
compatible modes; explicit manual and between_tools modes are not auto-recovered.

This change is a 0.0.65 release candidate. Publish the reviewed SDK package first,
then update the backend's exact dependency and lockfile to that published artifact,
build/deploy it, and verify real provider traces. A locally packed tarball is for
review/integration proof and does not establish a deployed or published version.

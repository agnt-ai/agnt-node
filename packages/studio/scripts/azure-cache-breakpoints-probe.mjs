#!/usr/bin/env node
/**
 * Live probe: GPT-5.6+ prompt-cache breakpoints, before vs after (providers/openaiPromptCache.ts).
 *
 * Replays a synthetic agent loop against a real deployment twice, with the same shape Prime sends: a ~40K-token
 * stable prefix (a system message whose static part is marked `cacheBoundary`, plus a long opening user message),
 * then each turn the model's function_call, a ~3K-token function_call_output, and a per-turn note that changes every
 * turn and is flagged `releaseAfterRead`.
 *   BEFORE: metadata.prompt_cache_breakpoints = false (no breakpoints: the service's implicit mode, as in prod today)
 *   AFTER:  this SDK's default (explicit mode, breakpoints on the static system part, earlier tails and the tail)
 * Each mode starts from its own random nonce at the very front of the prompt, so neither reads the other's cache.
 * Prints prompt / cached (read) / written / fresh tokens per turn.
 *
 * Cost (gpt-6.1-sol Global Standard, $2/M in, $0.10 read, $2.50 write, $10 out): about 2 x 3 turns x ~45K input
 * tokens, under $1 in the worst case (every token written). TURNS raises it linearly.
 *
 * Run from packages/studio after `npm run build`:
 *   AZURE_FOUNDRY_ENDPOINT=https://<resource>.openai.azure.com/openai/v1 AZURE_FOUNDRY_API_KEY=... \
 *     MODEL=gpt-6.1-sol node scripts/azure-cache-breakpoints-probe.mjs
 *   PROVIDER=openai OPENAI_API_KEY=... MODEL=<gpt-5.6+ model> node scripts/azure-cache-breakpoints-probe.mjs
 * Options (env): TURNS (default 3), MODES (default "before,after"), EFFORT (default low).
 */
import { randomBytes } from 'node:crypto';
import AzureFoundryExecutor from '../dist/providers/azureFoundry.js';
import OpenAIExecutor from '../dist/providers/openai.js';
import { breakpointIndexes } from '../dist/providers/openaiPromptCache.js';

const PROVIDER = process.env.PROVIDER || 'azureFoundry';
const MODEL = process.env.MODEL;
const TURNS = Number(process.env.TURNS || 3);
const MODES = (process.env.MODES || 'before,after').split(',').map((s) => s.trim()).filter(Boolean);
const EFFORT = process.env.EFFORT || 'low';
if (!MODEL) throw new Error('MODEL is required (the deployment name, e.g. a GPT-5.6+ deployment)');

const credentials = PROVIDER === 'openai'
  ? { openai: { apiKey: required('OPENAI_API_KEY') } }
  : { azureFoundry: { apiKey: required('AZURE_FOUNDRY_API_KEY'), endpoint: required('AZURE_FOUNDRY_ENDPOINT') } };
function required(name) { const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v; }

// Deterministic, token-dense filler (distinct words, so a ~4 chars/token estimate holds and nothing compresses).
const WORDS = 'harbor lantern quartz meadow cobalt ember thistle granite willow saffron orbit falcon juniper velvet canyon prism marble tundra coral cedar'.split(' ');
function filler(seed, tokens) {
  let x = seed >>> 0; const out = [];
  for (let i = 0; i < tokens; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out.push(WORDS[x % WORDS.length] + (x % 97)); }
  return out.join(' ');
}

const tools = [{ name: 'record_step', description: 'Record that one research step is done.', parameters: { type: 'object', properties: { step: { type: 'integer' }, note: { type: 'string' } }, required: ['step'] } }];

async function runMode(mode) {
  const nonce = randomBytes(6).toString('hex');
  const metadata = { reasoning_effort: EFFORT, max_output_tokens: 1500, prompt_cache_key: `probe-${nonce}`, ...(mode === 'before' ? { prompt_cache_breakpoints: false } : {}) };
  const Executor = PROVIDER === 'openai' ? OpenAIExecutor : AzureFoundryExecutor;
  const ex = new Executor({
    manifest: { kind: 'PromptManifest', apiVersion: 'v2', metadata: { name: 'cache-probe' }, spec: { models: [{ provider: PROVIDER, model: MODEL, metadata }], files: [], tools: [] } },
    credentials, logLevel: 'silent',
  });
  const sent = [];
  const create = ex.client.responses.create.bind(ex.client.responses);
  ex.client.responses.create = (params, opts) => { sent.push(params); return create(params, opts); };

  const transcript = [
    { role: 'system', content: [
      { type: 'text', text: `Probe ${nonce}. You are a research agent. Reference manual follows.\n${filler(1, 30_000)}`, cacheBoundary: true },
      { type: 'text', text: `Run context: probe ${nonce}, mode ${mode}.` },
    ] },
    { role: 'user', content: `Background material for the job:\n${filler(2, 10_000)}\n\nCall record_step once per turn with the next step number. Do not write prose.` },
  ];
  console.log(`\n== ${mode.toUpperCase()} (${PROVIDER} ${MODEL}, nonce ${nonce})`);
  console.log('turn  prompt   cached  written   fresh  hit%  breakpoints  mode');
  let cost = 0;
  for (let t = 1; t <= TURNS; t++) {
    const note = { role: 'user', content: `Communication timing context (guidance): turn ${t} at ${new Date().toISOString()}`, releaseAfterRead: true };
    const res = await ex.invoke([...transcript, note], { tools, tool_choice: 'required' });
    const u = res.usage ?? {};
    const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const params = sent.at(-1);
    cost += ((u.input_tokens ?? 0) * 2 + (u.cache_read_input_tokens ?? 0) * 0.1 + (u.cache_creation_input_tokens ?? 0) * 2.5 + (u.output_tokens ?? 0) * 10) / 1e6;
    console.log([
      String(t).padStart(4), String(prompt).padStart(7), String(u.cache_read_input_tokens ?? 0).padStart(8), String(u.cache_creation_input_tokens ?? 0).padStart(8),
      String(u.input_tokens ?? 0).padStart(7), String(prompt ? Math.round(100 * (u.cache_read_input_tokens ?? 0) / prompt) : 0).padStart(5),
      String(breakpointIndexes(params.input).length).padStart(12), `  ${params.prompt_cache_options?.mode ?? 'implicit(default)'}`,
    ].join(' '));
    transcript.push(res.message);
    const calls = res.message.tool_calls?.length ? res.message.tool_calls : [];
    if (!calls.length) { console.log('  (no tool call; stopping)'); break; }
    for (const call of calls) transcript.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ recorded: true, step: t, findings: filler(100 + t, 3_000) }) });
  }
  console.log(`  approx cost at gpt-6.1-sol Global Standard rates: $${cost.toFixed(3)}`);
}

for (const mode of MODES) await runMode(mode);

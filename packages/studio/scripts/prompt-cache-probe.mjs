#!/usr/bin/env node
/**
 * Live probe: does the prompt cache hold across the turns of an agent loop, on any provider (promptCacheCapabilities.ts)?
 *
 * Sends TURNS requests shaped like Prime's: a system message whose static part is marked `cacheBoundary` plus a
 * per-run part, one tool, an opening user message, then per turn an assistant tool call, its ~OUTPUT_TOKENS result
 * and a per-turn note flagged `releaseAfterRead` that changes every turn. The assistant turns are synthetic (the
 * model's own replies are ignored), so every request repeats the previous one byte for byte up to its note. A random
 * nonce at the front keeps a run from reading an earlier run's cache. Prints prompt / read / written / fresh per turn.
 * Expected: turn 1 writes (or, on automatic-cache providers, reads 0); every later turn reads about the whole previous
 * request (prompt minus the newest tool result and note).
 *
 * Run from packages/studio after `npm run build` (each costs cents at TURNS=4, PREFIX_TOKENS=8000):
 *   PROVIDER=anthropic ANTHROPIC_API_KEY=... MODEL=claude-haiku-4-5-20251001 node scripts/prompt-cache-probe.mjs
 *   PROVIDER=bedrock AWS_REGION=us-east-1 [AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or default chain] \
 *     MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0 node scripts/prompt-cache-probe.mjs
 *   PROVIDER=google GOOGLE_API_KEY=... MODEL=gemini-3.8-flash node scripts/prompt-cache-probe.mjs
 *   PROVIDER=together API_KEY=... MODEL=moonshotai/Kimi-K2.6 node scripts/prompt-cache-probe.mjs   (any OpenAI-compatible
 *     host: deepseek, moonshot, fireworks, deepinfra; xai/groq/mistral also need BASE_URL)
 *   PROVIDER=openai OPENAI_API_KEY=... MODEL=gpt-4.1 node scripts/prompt-cache-probe.mjs   (pre-5.6 automatic caching;
 *     GPT-5.6+ and Azure: scripts/azure-cache-breakpoints-probe.mjs)
 * Options (env): TURNS (default 4), PREFIX_TOKENS (default 8000; above every provider's minimum), OUTPUT_TOKENS
 * (default 1500), KEY (a lane key sent as metadata.prompt_cache_key; the adapter decides whether it goes out),
 * DISABLE_BREAKPOINTS=1 (metadata.prompt_cache_breakpoints = false: the before state on Anthropic/Bedrock).
 */
import { randomBytes } from 'node:crypto';
import { createExecutor } from '../dist/index.js';

const PROVIDER = process.env.PROVIDER;
const MODEL = process.env.MODEL;
if (!PROVIDER || !MODEL) throw new Error('PROVIDER and MODEL are required');
const TURNS = Number(process.env.TURNS || 4);
const PREFIX_TOKENS = Number(process.env.PREFIX_TOKENS || 8_000);
const OUTPUT_TOKENS = Number(process.env.OUTPUT_TOKENS || 1_500);

const env = (n) => process.env[n];
const NATIVE = {
  anthropic: { apiKey: env('ANTHROPIC_API_KEY') },
  bedrock: { region: env('AWS_REGION') || 'us-east-1', accessKeyId: env('AWS_ACCESS_KEY_ID'), secretAccessKey: env('AWS_SECRET_ACCESS_KEY') },
  google: { apiKey: env('GOOGLE_API_KEY') },
  openai: { apiKey: env('OPENAI_API_KEY') },
};
const credentials = { [PROVIDER]: NATIVE[PROVIDER] ?? { apiKey: env('API_KEY'), ...(env('BASE_URL') ? { baseURL: env('BASE_URL') } : {}) } };

const WORDS = 'harbor lantern quartz meadow cobalt ember thistle granite willow saffron orbit falcon juniper velvet canyon prism marble tundra coral cedar'.split(' ');
function filler(seed, tokens) {
  let x = seed >>> 0; const out = [];
  for (let i = 0; i < tokens; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out.push(WORDS[x % WORDS.length] + (x % 97)); }
  return out.join(' ');
}

const metadata = { max_tokens: 64, ...(env('KEY') ? { prompt_cache_key: env('KEY') } : {}), ...(env('DISABLE_BREAKPOINTS') === '1' ? { prompt_cache_breakpoints: false } : {}) };
const manifest = { kind: 'PromptManifest', apiVersion: 'v2', spec: { models: [{ provider: PROVIDER, model: MODEL, metadata }], files: [], tools: [] } };
const executor = await createExecutor({ manifest, credentials, logLevel: 'silent', log: () => {} });
const tools = [{ name: 'record_step', description: 'Record that one research step is done.', parameters: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'] } }];

const nonce = randomBytes(8).toString('hex');
const base = [
  { role: 'system', content: [
    { type: 'text', text: `Run ${nonce}. You are a careful research assistant. Reference:\n${filler(1, Math.floor(PREFIX_TOKENS * 0.75))}`, cacheBoundary: true },
    { type: 'text', text: `Per-run context ${nonce}: today is a test day.` },
  ] },
  { role: 'user', content: `Briefing:\n${filler(2, Math.floor(PREFIX_TOKENS * 0.25))}\nCall record_step once per step.` },
];
const history = [...base];
console.log(`provider=${PROVIDER} model=${MODEL} turns=${TURNS}`);
console.log('turn  prompt    read   written   fresh   hit%');
for (let t = 1; t <= TURNS; t++) {
  const note = { role: 'user', content: `Turn note ${t}: clock ${new Date().toISOString()}. Continue.`, releaseAfterRead: true };
  const res = await executor.invoke([...history, note], { tools });
  const u = res.usage ?? {};
  const read = u.cache_read_input_tokens ?? 0, written = u.cache_creation_input_tokens ?? 0, fresh = u.input_tokens ?? 0;
  const prompt = read + written + fresh;
  console.log(`${String(t).padStart(4)} ${String(prompt).padStart(7)} ${String(read).padStart(7)} ${String(written).padStart(9)} ${String(fresh).padStart(7)} ${String(prompt ? Math.round((read / prompt) * 100) : 0).padStart(5)}`);
  const id = `call_${nonce}_${t}`;
  history.push({ role: 'assistant', content: '', tool_calls: [{ id, name: 'record_step', args: { step: t } }] });
  history.push({ role: 'tool', tool_call_id: id, content: `step ${t} recorded. Findings: ${filler(100 + t, OUTPUT_TOKENS)}` });
}

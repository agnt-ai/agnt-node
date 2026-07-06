/**
 * Unit tests for OpenAICompatibleExecutor's response mapping — specifically the
 * reasoning-model answer recovery.
 *
 * Reasoning models (Qwen, DeepSeek-R1) served over the OpenAI-compatible wire
 * (Together) return their FINAL ANSWER in `reasoning_content` and leave
 * `content` null on a productive `finish_reason:stop` turn. The mapper must
 * recover that answer, strip inline `<think>` blocks, and — when a productive
 * turn yields nothing usable — throw a retryable error rather than silently
 * returning an empty result.
 *
 * These drive the PUBLIC `invoke()` by stubbing the OpenAI client's streaming
 * create() with a hand-built chunk stream, so they exercise the real streamed
 * assembly (consumeOpenAIStream) + fallback resolution end to end.
 */

import { describe, it, expect, vi } from 'vitest';
import OpenAICompatibleExecutor from '../openaiCompatible.js';

/** Minimal valid manifest for a single together/Qwen model. */
function makeManifest() {
  return {
    kind: 'PromptManifest',
    apiVersion: 'v2',
    spec: {
      models: [{ provider: 'together', model: 'Qwen/Qwen3.5-9B' }],
      files: [],
      tools: [],
    },
  } as any;
}

/** Build an executor with a stubbed OpenAI client whose streamed completion
 *  yields `chunks`. Returns the executor so the test can call invoke(). */
function makeExecutor(chunks: any[]) {
  const ex = new OpenAICompatibleExecutor({
    manifest: makeManifest(),
    credentials: { together: { apiKey: 'sk-test' } },
    logLevel: 'silent',
  } as any);

  async function* gen() {
    for (const c of chunks) yield c;
  }
  // Replace the real network call with our canned stream.
  (ex as any).client = {
    chat: { completions: { create: vi.fn(async () => gen()) } },
  };
  return ex;
}

/** Assemble the chunk sequence for a single non-tool `stop` turn carrying the
 *  given content / reasoning_content, plus a usage chunk. */
function textTurn(opts: {
  content?: string | null;
  reasoning_content?: string | null;
  completion_tokens?: number;
}) {
  const delta: any = { role: 'assistant' };
  if (typeof opts.content === 'string') delta.content = opts.content;
  if (typeof opts.reasoning_content === 'string') delta.reasoning_content = opts.reasoning_content;
  return [
    { choices: [{ index: 0, delta }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: opts.completion_tokens ?? 100 } },
  ];
}

describe('OpenAICompatibleExecutor — reasoning-model answer recovery', () => {
  it('falls back to reasoning_content when content is null on a stop turn', async () => {
    const answer = '1. Foo\n2. Bar';
    const ex = makeExecutor(textTurn({ content: null, reasoning_content: answer, completion_tokens: 410 }));
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.content).toBe(answer);
    expect(result.message.tool_calls).toEqual([]);
    // reasoning promoted → tokens still counted as output
    expect(result.usage.output_tokens).toBe(410);
  });

  it('does NOT promote reasoning on a tool-call turn (content stays empty)', async () => {
    const chunks = [
      {
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            reasoning_content: 'I should call the search tool',
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
        }],
      },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 50 } },
    ];
    const ex = makeExecutor(chunks);
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls[0].name).toBe('search');
    // content must NOT be polluted with the reasoning text
    expect(result.message.content).toBe('');
    expect(result.message.content).not.toContain('search tool');
  });

  it('strips a leading <think> block and keeps the real answer after it', async () => {
    const ex = makeExecutor(textTurn({
      content: '<think>let me reason about this</think>The answer is 42.',
    }));
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.content).toBe('The answer is 42.');
  });

  it('falls back to reasoning_content when content is a think-only block', async () => {
    const ex = makeExecutor(textTurn({
      content: '<think>just thinking, no answer here</think>',
      reasoning_content: 'The real answer lives in reasoning_content.',
    }));
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.content).toBe('The real answer lives in reasoning_content.');
  });

  it('throws a retryable error when a productive turn yields empty content, no reasoning, no tool_calls', async () => {
    const ex = makeExecutor(textTurn({ content: null, completion_tokens: 448 }));
    // No fallback models in the manifest → invokeWithFallback would rethrow; here
    // we hit invoke() directly, which throws the malformed-response error.
    const err = await ex.invoke([{ role: 'user', content: 'go' }] as any).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).status).toBe(502);
    expect((err as any).isMalformedEmptyResponse).toBe(true);
    // and BaseExecutor classifies it as retryable (rides model fallback)
    expect((ex as any).isRetryableError(err)).toBe(true);
  });

  it('does NOT throw for a genuinely empty turn (0 output tokens)', async () => {
    const ex = makeExecutor(textTurn({ content: null, completion_tokens: 0 }));
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.content).toBe('');
  });

  it('returns normal content untouched when the model behaves', async () => {
    const ex = makeExecutor(textTurn({ content: 'Here is the plain answer.' }));
    const result = await ex.invoke([{ role: 'user', content: 'go' }] as any);
    expect(result.message.content).toBe('Here is the plain answer.');
  });
});

/**
 * Every adapter honours the caller's deadline and the executor's idle-retry
 * budget. The streamed adapters thread both into streamWithRetry (checked on
 * source: a dropped option would silently restore three stalls per model on
 * that provider); Bedrock, which does not stream through the guard, enforces
 * deadlineAt itself (driven below with the AWS client mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const send = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function () { return { send }; }),
  ConverseCommand: vi.fn().mockImplementation(function (input: any) { return { input }; }),
}));

import BedrockExecutor from '../providers/bedrock.js';
import { StreamAbortError } from '../providers/streaming.js';

const src = (f: string) => readFileSync(fileURLToPath(new URL(`../providers/${f}`, import.meta.url)), 'utf8');

describe('streamed adapters pass deadlineAt and idleRetries to every streamWithRetry call', () => {
  for (const file of ['anthropic.ts', 'openai.ts', 'google.ts', 'azureFoundry.ts', 'openaiCompatible.ts']) {
    it(file, () => {
      const code = src(file);
      const optionBlocks = [...code.matchAll(/externalSignal: options\.signal,\n\s*deadlineAt: options\.deadlineAt,\n\s*idleRetries: options\.idleRetries,/g)].length;
      const sites = [...code.matchAll(/await streamWithRetry\(|=> streamWithRetry\(/g)].length;
      expect(sites).toBeGreaterThan(0);
      expect(optionBlocks).toBe(sites);
    });
  }
});

function config() {
  return {
    manifest: {
      $schema: 'x', kind: 'PromptManifest', apiVersion: 'v2', metadata: { name: 't', title: 't', description: '' },
      spec: { routingStrategy: 'fallback', enableToolCalls: false, variables: [], files: [], tools: [],
        models: [{ provider: 'bedrock', model: 'some-model' }], dependencies: [] },
    },
    credentials: { bedrock: { region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' } },
    logLevel: 'silent',
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('Bedrock enforces deadlineAt itself', () => {
  it('a request still running at the deadline is aborted and reported as "deadline"', async () => {
    send.mockImplementation((_cmd: any, { abortSignal }: any) => new Promise((_, reject) => {
      abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const ex = new BedrockExecutor(config());
    const started = Date.now();
    const err = await ex.invoke([{ role: 'user', content: 'hi' }], { deadlineAt: Date.now() + 40 }).catch((e: any) => e);
    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('past the deadline no request is sent', async () => {
    const ex = new BedrockExecutor(config());
    const err = await ex.invoke([{ role: 'user', content: 'hi' }], { deadlineAt: Date.now() - 1 }).catch((e: any) => e);
    expect(err.reason).toBe('deadline');
    expect(send).not.toHaveBeenCalled();
  });

  it('a fractional deadlineAt still sends the request and aborts at the deadline (no ERR_OUT_OF_RANGE)', async () => {
    send.mockImplementation((_cmd: any, { abortSignal }: any) => new Promise((_, reject) => {
      abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const ex = new BedrockExecutor(config());
    const err = await ex.invoke([{ role: 'user', content: 'hi' }], { deadlineAt: Date.now() + 40.5 }).catch((e: any) => e);
    expect(send).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(StreamAbortError);
    expect(err.reason).toBe('deadline');
  });

  it('a deadline more than ~24.8 days away does not abort the request early', async () => {
    let seen: AbortSignal | undefined;
    send.mockImplementation(async (_cmd: any, { abortSignal }: any) => {
      seen = abortSignal;
      await new Promise((r) => setTimeout(r, 30));
      if (abortSignal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const ex = new BedrockExecutor(config());
    const res = await ex.invoke([{ role: 'user', content: 'hi' }], { deadlineAt: Date.now() + 40 * 24 * 3600 * 1000 });
    expect(seen?.aborted).toBe(false);
    expect(res.message.content).toBe('ok');
  });

  it('a caller stop is still a caller stop, not a deadline', async () => {
    send.mockImplementation((_cmd: any, { abortSignal }: any) => new Promise((_, reject) => {
      abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const ex = new BedrockExecutor(config());
    const err = await ex.invoke([{ role: 'user', content: 'hi' }], { signal: stop.signal, deadlineAt: Date.now() + 10_000 }).catch((e: any) => e);
    expect(err).not.toBeInstanceOf(StreamAbortError);
  });
});

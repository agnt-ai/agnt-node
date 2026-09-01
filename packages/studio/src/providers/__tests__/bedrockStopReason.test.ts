/**
 * BedrockExecutor — Converse `stopReason` pass-through.
 *
 * The Converse API can report a context-window overflow as a SUCCESSFUL
 * HTTP 200: `stopReason: "model_context_window_exceeded"` (a documented enum
 * value) with an empty output message. Nothing is thrown and there is no error
 * string anywhere in the payload, so no error-message pattern — however broad —
 * can ever detect it. The only signal is `stopReason`, and it lived and died
 * inside this adapter: invoke() returned `{ message, usage }` and dropped it.
 *
 * These tests drive the REAL adapter against a faked Converse response and pin
 * that the value crosses the package boundary. The adapter deliberately does no
 * interpretation — it transports the string verbatim; the caller owns the
 * policy decision about what any given stopReason means.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// AWS SDK mock — the adapter builds a ConverseCommand and hands it to
// client.send(); we intercept send() and return a canned Converse response.
// ─────────────────────────────────────────────────────────────────────────────

const bedrockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function () { return { send: bedrockSend }; }),
  ConverseCommand: vi.fn().mockImplementation(function (params: any) { return { params }; }),
}));

import BedrockExecutor from '../bedrock.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(model = 'anthropic.claude-3-5-sonnet-20240620-v1:0') {
  return {
    kind: 'PromptManifest',
    apiVersion: 'v2',
    spec: {
      models: [{ provider: 'bedrock', model }],
      files: [],
      tools: [],
    },
  } as any;
}

function makeExecutor() {
  return new BedrockExecutor({
    manifest: makeManifest(),
    credentials: { bedrock: { region: 'us-east-2', accessKeyId: 'AK', secretAccessKey: 'SK' } },
    logLevel: 'silent',
  } as any);
}

/** A Converse HTTP-200 response. `stopReason` is omitted entirely when null,
 *  so a test can prove the absent case behaves exactly as before. */
function converseResponse(stopReason: string | null, content: any[] = [{ text: 'hello' }]) {
  return {
    output: { message: { role: 'assistant', content } },
    ...(stopReason === null ? {} : { stopReason }),
    usage: { inputTokens: 1234, outputTokens: 56 },
  };
}

function bedrockReturns(response: any) {
  bedrockSend.mockImplementation(async () => response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// The blind spot: a SUCCESS response carrying the overflow enum
// ─────────────────────────────────────────────────────────────────────────────

describe('BedrockExecutor — Converse stopReason crosses the package boundary', () => {
  it('surfaces stopReason "model_context_window_exceeded" from an HTTP 200 with nothing thrown', async () => {
    // Real overflow shape: 200, empty output message, no error string at all.
    bedrockReturns(converseResponse('model_context_window_exceeded', [{ text: '' }]));

    const result = await makeExecutor().invoke([{ role: 'user', content: 'a very long prompt' }]);

    // The whole point: the caller can read it.
    expect(result.stopReason).toBe('model_context_window_exceeded');

    // Proof there is no other signal to detect this by — the adapter saw a
    // perfectly successful response with an empty message and no error.
    expect(result.message.content).toBe('');
    expect((result as any).error).toBeUndefined();
  });

  it('passes ordinary stopReasons through verbatim without interpreting them', async () => {
    for (const reason of ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'content_filtered']) {
      bedrockReturns(converseResponse(reason));
      // Must not throw and must not remap — transport only, no policy.
      const result = await makeExecutor().invoke([{ role: 'user', content: 'hi' }]);
      expect(result.stopReason).toBe(reason);
    }
  });

  it('omits the field entirely when Converse sends no stopReason (absence behaves as before)', async () => {
    bedrockReturns(converseResponse(null));

    const result = await makeExecutor().invoke([{ role: 'user', content: 'hi' }]);

    expect(result.stopReason).toBeUndefined();
    expect('stopReason' in result).toBe(false);
  });

  it('leaves the existing message/usage mapping untouched', async () => {
    bedrockReturns(converseResponse('end_turn'));

    const result = await makeExecutor().invoke([{ role: 'user', content: 'hi' }]);

    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('hello');
    expect(result.message.tool_calls).toEqual([]);
    expect(result.usage).toEqual({ input_tokens: 1234, output_tokens: 56 });
  });

  it('still surfaces stopReason alongside tool calls', async () => {
    bedrockReturns(
      converseResponse('tool_use', [
        { text: 'calling a tool' },
        { toolUse: { toolUseId: 'tu-1', name: 'search', input: { q: 'x' } } },
      ])
    );

    const result = await makeExecutor().invoke([{ role: 'user', content: 'hi' }]);

    expect(result.stopReason).toBe('tool_use');
    expect(result.message.tool_calls).toEqual([{ id: 'tu-1', name: 'search', args: { q: 'x' } }]);
  });
});

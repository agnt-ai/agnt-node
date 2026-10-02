import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openAIResponsesStreamFromResponse, googleStreamResult, anthropicMessageStream } from './_streamMocks.js';
const responsesCreate = vi.fn();
const googleStream = vi.fn();
const googleModel = vi.fn(() => ({ generateContentStream: googleStream }));
const anthropicStream = vi.fn();
vi.mock('openai', () => ({ default: vi.fn().mockImplementation(function () { return { responses: { create: responsesCreate }, chat: { completions: { create: vi.fn() } } }; }) }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: vi.fn().mockImplementation(function () { return { getGenerativeModel: googleModel }; }) }));
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn().mockImplementation(function () { return { messages: { stream: anthropicStream } }; }) }));
import OpenAIExecutor from '../providers/openai.js';
import AzureExecutor from '../providers/azureFoundry.js';
import GoogleExecutor from '../providers/google.js';
import AnthropicExecutor from '../providers/anthropic.js';
import { geminiThinkingConfig } from '../providers/geminiThinking.js';
import { traceMessage, nativeStatePresence } from '../providers/nativeState.js';
import type { BaseExecutorConfig, Message } from '../types.js';
function config(provider: string, model: string, metadata: any = {}): BaseExecutorConfig {
  return { manifest: { kind: 'PromptManifest', apiVersion: 'v2', metadata: { name: 'test' }, spec: { models: [{ provider, model, metadata }], files: [], tools: [], variables: [], dependencies: [] } }, credentials: { openai: { apiKey: 'dummy' }, azureFoundry: { apiKey: 'dummy', endpoint: 'https://dummy.openai.azure.com/openai/v1/' }, google: { apiKey: 'dummy' }, anthropic: { apiKey: 'dummy' } }, logLevel: 'silent' } as BaseExecutorConfig;
}
beforeEach(() => vi.clearAllMocks());
const output = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-secret', summary: [{ type: 'summary_text', text: 'Checked the weather.' }] },
  { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Looking up weather.', annotations: [] }] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'weather', arguments: '{"city":"NYC"}', status: 'completed' },
  { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'time', arguments: '{}', status: 'completed' },
];
function responses(reasoning: number | undefined) {
  responsesCreate.mockImplementation(async () => openAIResponsesStreamFromResponse({ status: 'completed', output, usage: { input_tokens: 50, output_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: reasoning === undefined ? {} : { reasoning_tokens: reasoning } } }));
}
describe.each([['openai', OpenAIExecutor], ['azureFoundry', AzureExecutor]] as const)('%s Responses native continuity', (provider, Executor) => {
  it('replays exact ordered output once, preserving IDs, phase, opaque state and two function results', async () => {
    responses(17);
    const ex = new Executor(config(provider, 'gpt-5.6', { reasoning_effort: 'high', reasoning: { summary: 'auto' } }));
    const user: Message = { role: 'user', content: 'Weather?' };
    const first = await ex.invoke([user]);
    expect(first.message.content).toBe('Looking up weather.');
    expect(first.message.reasoningSummary).toEqual([{ type: 'summary_text', text: 'Checked the weather.' }]);
    expect(first.usage).toMatchObject({ input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 17 });
    expect(first.reasoningConfig).toMatchObject({ provider, model: 'gpt-5.6', source: 'provider-request', settings: { reasoning: { effort: 'high', summary: 'auto' } } });
    await ex.invoke([user, JSON.parse(JSON.stringify(first.message)), { role: 'tool', tool_call_id: 'call_1', content: '{"degrees":72}' }, { role: 'tool', tool_call_id: 'call_2', content: '{"time":"noon"}' }]);
    const input = responsesCreate.mock.calls[1][0].input;
    expect(input.slice(1, 5)).toEqual(output);
    expect(input.slice(5)).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: '{"degrees":72}' }, { type: 'function_call_output', call_id: 'call_2', output: '{"time":"noon"}' }]);
    expect(input.filter((i: any) => i.type === 'function_call')).toHaveLength(2);
    expect(input.filter((i: any) => i.type === 'message')).toHaveLength(1);
  });
  it.each(['foreign-provider', 'foreign-model'])('reconstructs canonical calls without opaque %s state', async mismatch => {
    responses(17); const ex = new Executor(config(provider, 'gpt-5.6'));
    const first = await ex.invoke([{ role: 'user', content: 'hi' }]);
    first.message.nativeState![mismatch === 'foreign-provider' ? 'provider' : 'model'] = 'other';
    await ex.invoke([first.message, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }]);
    const input = responsesCreate.mock.calls[1][0].input;
    expect(input.some((i: any) => i.type === 'reasoning')).toBe(false);
    expect(input.filter((i: any) => i.type === 'function_call')).toHaveLength(2);
    expect(JSON.stringify(input)).not.toContain('opaque-secret');
  });
  it.each([0, undefined])('preserves zero/absent detail (%s) without adding to output total', async reasoning => {
    responses(reasoning); const result = await new Executor(config(provider, 'gpt-5.6')).invoke([{ role: 'user', content: 'hi' }]);
    expect(result.usage?.output_tokens).toBe(30);
    if (reasoning === undefined) expect(result.usage).not.toHaveProperty('reasoning_output_tokens');
    else expect(result.usage?.reasoning_output_tokens).toBe(0);
  });
});
function gemini(parts: any[], thoughts: number | undefined, streamed: boolean) {
  const aggregate = parts.map(({ thought, thoughtSignature, ...part }) => part); // old SDK destroys flags
  googleStream.mockImplementation(async () => googleStreamResult({ candidates: [{ content: { role: 'model', parts: streamed ? aggregate : parts } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, ...(thoughts === undefined ? {} : { thoughtsTokenCount: thoughts }) } }, streamed ? [{ candidates: [{ content: { parts } }] }] : []));
}
describe('Gemini native continuity', () => {
  it.each([true, false])('separates summaries and preserves final-answer signatures (raw stream=%s)', async streamed => {
    const parts = [{ text: 'Checked arithmetic.', thought: true }, { text: '42', thoughtSignature: 'signed-answer' }];
    gemini(parts, 17, streamed); const ex = new GoogleExecutor(config('google', 'gemini-3.1-pro-preview', { reasoning_effort: 'medium', generationConfig: { thinkingConfig: { includeThoughts: true } } }));
    const first = await ex.invoke([{ role: 'user', content: 'hi' }]);
    expect(first.message.content).toBe('42');
    expect(first.message.reasoningSummary).toEqual([{ type: 'summary_text', text: 'Checked arithmetic.' }]);
    expect(first.usage).toMatchObject({ output_tokens: 22, reasoning_output_tokens: 17 });
    expect(first.reasoningConfig?.settings.thinkingConfig).toEqual({ thinkingLevel: 'medium', includeThoughts: true });
    await ex.invoke([JSON.parse(JSON.stringify(first.message)), { role: 'user', content: 'continue' }]);
    expect(googleStream.mock.calls[1][0].contents[0]).toEqual({ role: 'model', parts });
    expect(googleModel.mock.calls[0][0].reasoning_effort).toBeUndefined();
  });
  it('replays parallel signed tool parts once with corresponding results', async () => {
    const parts = [{ functionCall: { name: 'weather', args: {} }, thoughtSignature: 'signed-tool' }, { functionCall: { name: 'time', args: {} } }];
    gemini(parts, 0, true); const ex = new GoogleExecutor(config('google', 'gemini-3-flash-preview'));
    const first = await ex.invoke([{ role: 'user', content: 'hi' }]);
    await ex.invoke([first.message, { role: 'tool', tool_call_id: 'weather', content: 'ok' }, { role: 'tool', tool_call_id: 'time', content: 'ok' }]);
    const contents = googleStream.mock.calls[1][0].contents;
    expect(contents[0].parts).toEqual(parts); expect(contents).toHaveLength(3);
    expect(first.usage?.reasoning_output_tokens).toBe(0);
  });
  it('rejects incompatible envelopes and foreign/malformed legacy rawParts', async () => {
    gemini([{ text: 'done' }], undefined, true); const ex = new GoogleExecutor(config('google', 'gemini-3-flash-preview'));
    for (const rawParts of [[{ type: 'thinking', thinking: 'private', signature: 'x' }], [{ text: 'private', thoughtSignature: 42 }]]) {
      await ex.invoke([{ role: 'assistant', content: 'answer', rawParts }]);
      expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual([{ text: 'answer' }]);
    }
    const first = await ex.invoke([{ role: 'user', content: 'hi' }]); first.message.nativeState!.model = 'other';
    await ex.invoke([first.message]); expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual([{ text: 'done' }]);
    expect(first.usage).not.toHaveProperty('reasoning_output_tokens');
  });
});
describe('Anthropic continuity', () => {
  it('preserves full block order and thinking display under adaptive mapping', async () => {
    const blocks = [{ type: 'thinking', thinking: 'Public summary', signature: 'opaque-signature' }, { type: 'tool_use', id: 'call_1', name: 'weather', input: {} }, { type: 'text', text: 'Checking.' }];
    anthropicStream.mockImplementation(() => anthropicMessageStream({ role: 'assistant', content: blocks, usage: { input_tokens: 1, output_tokens: 10 } }));
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5', { reasoning_effort: 'high', thinking: { display: 'summarized' } }));
    const first = await ex.invoke([{ role: 'user', content: 'hi' }]);
    expect(first.message.reasoningSummary).toEqual([{ type: 'summary_text', text: 'Public summary' }]);
    await ex.invoke([first.message, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }]);
    expect(anthropicStream.mock.calls[1][0].messages[0].content).toEqual(blocks);
    expect(anthropicStream.mock.calls[0][0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });
  it('does not replay foreign or malformed legacy signatures', async () => {
    anthropicStream.mockImplementation(() => anthropicMessageStream({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5'));
    for (const rawParts of [[{ text: 'private', thoughtSignature: 'x' }], [{ type: 'thinking', thinking: 'private', signature: 42 }]]) {
      await ex.invoke([{ role: 'assistant', content: 'answer', rawParts }]);
      expect(anthropicStream.mock.lastCall![0].messages[0].content).toEqual([expect.objectContaining({ type: 'text', text: 'answer' })]);
    }
  });
});
it('uses only supported Gemini mappings and gives explicit native controls precedence', () => {
  expect(geminiThinkingConfig('gemini-2.5-pro', 'none')).toBeUndefined();
  expect(geminiThinkingConfig('gemini-2.5-flash', 'none')).toEqual({ thinkingBudget: 0 });
  expect(geminiThinkingConfig('gemini-2.5-flash', 'high')).toEqual({ thinkingBudget: 16384 });
  expect(geminiThinkingConfig('gemini-3-pro-preview', 'medium')).toBeUndefined();
  expect(geminiThinkingConfig('gemini-3.1-pro-preview', 'medium')).toEqual({ thinkingLevel: 'medium' });
  expect(geminiThinkingConfig('gemini-3.8-flash', 'minimal')).toBeUndefined();
  expect(geminiThinkingConfig('unknown', 'high')).toBeUndefined();
  expect(geminiThinkingConfig('gemini-3-flash-preview', 'xhigh')).toBeUndefined();
  expect(geminiThinkingConfig('gemini-2.5-flash', 'high', { thinkingBudget: -1, includeThoughts: true })).toEqual({ thinkingBudget: -1, includeThoughts: true });
});
it('traces public summaries without opaque/native legacy state', () => {
  const message: Message = { role: 'assistant', content: 'answer', nativeState: { provider: 'openai', model: 'gpt-5.6', format: 'openai-responses', items: output }, rawParts: [{ signature: 'secret' }], reasoningSummary: [{ type: 'summary_text', text: 'public' }] };
  expect(traceMessage(message)).toEqual({ role: 'assistant', content: 'answer', reasoningSummary: [{ type: 'summary_text', text: 'public' }] });
  expect(message.nativeState?.items).toEqual(output);
});

describe('Anthropic prefix binding recovery', () => {
  const mismatch = { status: 400, error: { error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' } } };
  const final = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Public summary', signature: 'new-signature' }, { type: 'text', text: 'answer' }], usage: { input_tokens: 1, output_tokens: 10 }, input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch', opaque: 'must-not-leak' }] };
  it('retries documented400 once, merges beta headers, reports degraded state, persists policy across JSON resume', async () => {
    anthropicStream.mockImplementationOnce(() => { throw mismatch; }).mockImplementation(() => anthropicMessageStream(final));
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { reasoning_effort: 'high', anthropic_beta: ['existing-beta'] }));
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const result = await ex.invoke(messages);
    expect(anthropicStream).toHaveBeenCalledTimes(2);
    expect(anthropicStream.mock.calls[0][0].thinking).toEqual({ type: 'adaptive' });
    const retry = anthropicStream.mock.calls[1];
    expect(retry[0].messages).toEqual(anthropicStream.mock.calls[0][0].messages);
    expect(retry[0].thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(retry[0].anthropic_beta).toBeUndefined();
    expect(retry[1].headers['anthropic-beta']).toBe('existing-beta,thinking-binding-controls-2026-08-01');
    expect(result.prefixBindingRecovery).toEqual({ attempted: true, reason: 'prefix_binding_mismatch', requestedBehavior: 'drop_block' });
    expect(result.reasoningConfig?.settings.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
    expect(result.inputTransformations).toEqual([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }]);
    expect(result.message.nativeState?.replayPolicy).toEqual({ prefixMismatchBehavior: 'drop_block' });
    const resumed = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { reasoning_effort: 'high' }));
    await resumed.invoke([...messages, JSON.parse(JSON.stringify(result.message)), { role: 'user', content: 'continue' }]);
    expect(anthropicStream.mock.lastCall![0].thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
    await ex.invoke(messages); // instance remembers the successful recovery even when only initial messages are supplied
    expect(anthropicStream.mock.lastCall![0].thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
    (ex as any).model = 'claude-opus-5-5'; // same-provider fallback changes the model on this instance
    await ex.invoke(messages);
    expect(anthropicStream.mock.lastCall![0].thinking).toEqual({ type: 'adaptive' });
  });
  it.each(['error', 'drop_block'])('preserves explicit caller %s policy without automatic retry', async policy => {
    anthropicStream.mockImplementation(() => { throw mismatch; });
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { reasoning_effort: 'high', thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: policy } } }));
    await expect(ex.invoke([{ role: 'user', content: 'hi' }])).rejects.toEqual(mismatch);
    expect(anthropicStream).toHaveBeenCalledTimes(1);
    expect(anthropicStream.mock.calls[0][0].thinking.block_binding.prefix_mismatch_behavior).toBe(policy);
  });
  it.each([
    { status: 400, message: 'Invalid `signature` in `thinking` block. Signature invalid.' },
    { status: 400, message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different model.' },
    { status: 401, message: mismatch.error.error.message },
  ])('does not retry generic/tampered signatures or other errors', async error => {
    anthropicStream.mockImplementation(() => { throw error; });
    await expect(new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { reasoning_effort: 'high' })).invoke([{ role: 'user', content: 'hi' }])).rejects.toEqual(error);
    expect(anthropicStream).toHaveBeenCalledTimes(1);
  });
  it('fails honestly after the one recovery request fails', async () => {
    anthropicStream.mockImplementation(() => { throw mismatch; });
    await expect(new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5')).invoke([{ role: 'user', content: 'hi' }])).rejects.toEqual(mismatch);
    expect(anthropicStream).toHaveBeenCalledTimes(2);
  });
  it.each(['enabled', 'between_tools', 'disabled'])('does not apply adaptive recovery to unsupported %s mode', async type => {
    anthropicStream.mockImplementation(() => { throw mismatch; });
    await expect(new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { thinking: { type, budget_tokens: 1024 } })).invoke([{ role: 'user', content: 'hi' }])).rejects.toEqual(mismatch);
    expect(anthropicStream).toHaveBeenCalledTimes(1);
  });
  it('does not inherit a foreign/model-incompatible envelope replay policy', async () => {
    anthropicStream.mockImplementation(() => anthropicMessageStream(final));
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { reasoning_effort: 'high' }));
    for (const state of [ { provider: 'other', model: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'other' } ]) {
      await ex.invoke([{ role: 'assistant', content: 'answer', nativeState: { ...state, format: 'anthropic-content', items: final.content, replayPolicy: { prefixMismatchBehavior: 'drop_block' } } }]);
      expect(anthropicStream.mock.lastCall![0].thinking).toEqual({ type: 'adaptive' });
    }
  });
  it('observes transformations with header alone, leaves policy unset', async () => {
    anthropicStream.mockImplementation(() => anthropicMessageStream({ ...final, input_transformations: [{ type: 'thinking_mismatch_allowed', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }] }));
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5-5', { reasoning_effort: 'high', anthropic_beta: 'thinking-binding-controls-2026-08-01' }));
    const result = await ex.invoke([{ role: 'user', content: 'hi' }]);
    expect(anthropicStream.mock.calls[0][0].thinking).toEqual({ type: 'adaptive' });
    expect(result.inputTransformations![0].type).toBe('thinking_mismatch_allowed');
    expect(result).not.toHaveProperty('prefixBindingRecovery');
  });
});
it('preserves realistic Gemini multi-chunk answer/summary/signatures and complete function arguments without duplicates', async () => {
  const chunks = [
    [{ text: 'Checking ', thought: true }], [{ text: 'facts.', thought: true }],
    [{ text: 'I will ' }], [{ text: 'look it up.' }],
    [{ functionCall: { id: 'provider-id-1', name: 'weather', args: { city: 'NYC', units: 'F' } }, thoughtSignature: 'signed-fc' }],
    [{ functionCall: { id: 'provider-id-2', name: 'time', args: { timezone: 'America/New_York' } } }],
  ];
  const parts = chunks.flat();
  googleStream.mockImplementation(async () => googleStreamResult({ candidates: [{ content: { parts: parts.map(({ thought, thoughtSignature, ...part }: any) => part) } }], usageMetadata: { candidatesTokenCount: 10, thoughtsTokenCount: 20 } }, chunks.map(parts => ({ candidates: [{ content: { parts } }] }))));
  const ex = new GoogleExecutor(config('google', 'gemini-3-flash-preview'));
  const first = await ex.invoke([{ role: 'user', content: 'weather' }]);
  expect(first.message.content).toBe('I will look it up.');
  expect(first.message.tool_calls).toEqual([{ id: 'weather', name: 'weather', args: { city: 'NYC', units: 'F' } }, { id: 'time', name: 'time', args: { timezone: 'America/New_York' } }]);
  await ex.invoke([first.message, { role: 'tool', tool_call_id: 'weather', content: '72' }, { role: 'tool', tool_call_id: 'time', content: 'noon' }]);
  expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual(parts);
  expect(first.message.nativeState?.items).toEqual(parts);
});
it('counts exposed reasoning/signature parts separately from envelope presence', () => {
  const message: Message = { role: 'assistant', content: '' };
  expect(nativeStatePresence(message)).toEqual({ present: false });
  message.nativeState = { provider: 'openai', model: 'gpt-5.6', format: 'openai-responses', items: output };
  expect(nativeStatePresence(message).observedReasoningParts).toBe(1);
  message.nativeState.items = [{ type: 'message', content: [{ type: 'output_text', text: 'plain' }] }];
  expect(nativeStatePresence(message)).toMatchObject({ present: true, observedReasoningParts: 0 });
  message.nativeState = { provider: 'anthropic', model: 'claude-sonnet-5', format: 'anthropic-content', items: [{ type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'plain' }] };
  expect(nativeStatePresence(message).observedReasoningParts).toBe(2);
  message.nativeState = { provider: 'google', model: 'gemini-3-flash-preview', format: 'gemini-parts', items: [{ text: 'summary', thought: true }, { text: 'plain', thoughtSignature: 'opaque' }] };
  expect(nativeStatePresence(message).observedReasoningParts).toBe(2);
});
describe.each([['openai', OpenAIExecutor], ['azureFoundry', AzureExecutor]] as const)('%s canonical history reconciliation', (provider, Executor) => {
  it('honors repaired oversized IDs, removes orphan calls, adds a canonical call once, preserves opaque state without mutating storage', async () => {
    const longId = 'call_' + 'x'.repeat(90);
    const native = [{ ...output[0] }, { ...output[1] }, { ...output[2], call_id: longId }, { ...output[3] }];
    responsesCreate.mockImplementation(async () => openAIResponsesStreamFromResponse({ status: 'completed', output: native, usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = new Executor(config(provider, 'gpt-5.6'));
    const first = await ex.invoke([{ role: 'user', content: 'go' }]);
    const unchangedState = JSON.stringify(first.message.nativeState);
    const repairedId = 'call_repaired_id_at_most_64';
    first.message.tool_calls = [{ ...first.message.tool_calls![0], id: repairedId }, { id: 'call_added', name: 'finish', args: { done: true } }];
    first.message.content = 'Shortened commentary.';
    await ex.invoke([first.message, { role: 'tool', tool_call_id: repairedId, content: 'ok' }, { role: 'tool', tool_call_id: 'call_added', content: 'done' }]);
    const input = responsesCreate.mock.lastCall![0].input;
    expect(input[0]).toEqual(native[0]);
    expect(input.find((item: any) => item.type === 'message')).toMatchObject({ id: 'msg_1', phase: 'commentary', content: [{ type: 'output_text', text: 'Shortened commentary.' }] });
    expect(input.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id)).toEqual([repairedId, 'call_added']);
    expect(input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id)).toEqual([repairedId, 'call_added']);
    expect(JSON.stringify(first.message.nativeState)).toBe(unchangedState);
    first.message.content = [{ type: 'text', text: 'Revised text parts.' }];
    await ex.invoke([first.message]);
    expect(responsesCreate.mock.lastCall![0].input.find((item: any) => item.type === 'message').content[0].text).toBe('Revised text parts.');
  });
  it('preclaims exact IDs when one of two identical calls is removed', async () => {
    const native = [output[0], { ...output[2], id: 'fc_a', call_id: 'call_a', arguments: ' { "x" : 1 } ' }, { ...output[2], id: 'fc_b', call_id: 'call_b', arguments: ' { "x" : 1 } ' }];
    responsesCreate.mockImplementation(async () => openAIResponsesStreamFromResponse({ status: 'completed', output: native }));
    const ex = new Executor(config(provider, 'gpt-5.6')); const first = await ex.invoke([{ role: 'user', content: 'go' }]);
    first.message.tool_calls = [first.message.tool_calls![1]];
    await ex.invoke([first.message, { role: 'tool', tool_call_id: 'call_b', content: 'ok' }]);
    expect(responsesCreate.mock.lastCall![0].input.slice(0, 2)).toEqual([native[0], native[2]]);
    first.message.tool_calls = [];
    await ex.invoke([first.message]);
    expect(responsesCreate.mock.lastCall![0].input).toEqual([native[0]]);
  });
  it('preserves all unedited message phases/content/JSON whitespace across multiple native messages', async () => {
    const native = [output[0], output[1], { ...output[2], arguments: ' { "city" : "NYC" } ' }, { ...output[1], id: 'msg_2', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }];
    responsesCreate.mockImplementation(async () => openAIResponsesStreamFromResponse({ status: 'completed', output: native }));
    const ex = new Executor(config(provider, 'gpt-5.6')); const first = await ex.invoke([{ role: 'user', content: 'go' }]);
    await ex.invoke([first.message]);
    expect(responsesCreate.mock.lastCall![0].input).toEqual(native);
  });
});
describe('Anthropic explicit native precedence and canonical history', () => {
  it.each([
    { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
    { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } },
  ])('preserves explicit native settings over generic high', async native => {
    anthropicStream.mockImplementation(() => anthropicMessageStream({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    await new AnthropicExecutor(config('anthropic', 'claude-sonnet-5', { reasoning_effort: 'high', ...native })).invoke([{ role: 'user', content: 'go' }]);
    expect(anthropicStream.mock.lastCall![0].thinking).toEqual(native.thinking);
    expect(anthropicStream.mock.lastCall![0].output_config).toEqual(native.output_config);
  });
  it('preserves an explicit manual budget and display over generic high', async () => {
    anthropicStream.mockImplementation(() => anthropicMessageStream({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const thinking = { type: 'enabled', budget_tokens: 2048, display: 'summarized' };
    await new AnthropicExecutor(config('anthropic', 'claude-haiku-4-5', { max_tokens: 16000, reasoning_effort: 'high', thinking })).invoke([{ role: 'user', content: 'go' }]);
    expect(anthropicStream.mock.lastCall![0].thinking).toEqual(thinking);
    expect(anthropicStream.mock.lastCall![0].reasoning_effort).toBeUndefined();
  });
  it('preserves a native output effort while generic effort fills adaptive mode alongside display/binding', async () => {
    anthropicStream.mockImplementation(() => anthropicMessageStream({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    await new AnthropicExecutor(config('anthropic', 'claude-sonnet-5', { reasoning_effort: 'high', output_config: { effort: 'low' }, thinking: { display: 'summarized', block_binding: { prefix_mismatch_behavior: 'error' } } })).invoke([{ role: 'user', content: 'go' }]);
    expect(anthropicStream.mock.lastCall![0].thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'error' } });
    expect(anthropicStream.mock.lastCall![0].output_config).toEqual({ effort: 'low' });
  });
  it('keeps unedited multiline blocks exact and repairs canonical tool IDs without mutating opaque blocks', async () => {
    const native = [{ type: 'thinking', thinking: 'summary', signature: 'opaque-sig' }, { type: 'text', text: ' line one ' }, { type: 'tool_use', id: 'original-id', name: 'weather', input: {} }, { type: 'text', text: 'line two' }];
    anthropicStream.mockImplementation(() => anthropicMessageStream({ content: native, usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = new AnthropicExecutor(config('anthropic', 'claude-sonnet-5')); const first = await ex.invoke([{ role: 'user', content: 'go' }], { disableCache: true });
    const snapshot = JSON.stringify(first.message.nativeState);
    await ex.invoke([first.message], { disableCache: true });
    expect(anthropicStream.mock.lastCall![0].messages[0].content).toEqual(native);
    first.message.tool_calls![0].id = 'repaired-id';
    await ex.invoke([first.message, { role: 'tool', tool_call_id: 'repaired-id', content: 'ok' }], { disableCache: true });
    expect(anthropicStream.mock.lastCall![0].messages[0].content).toEqual([native[0], native[1], { ...native[2], id: 'repaired-id' }, native[3]]);
    expect(JSON.stringify(first.message.nativeState)).toBe(snapshot);
  });
});
describe.each([false, true])('Gemini edited signed history (legacy rawParts=%s)', legacy => {
  const parts = [
    { functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'signature-for-Paris' },
    { functionCall: { name: 'weather', args: { city: 'London' } } },
  ];
  async function firstTurn() {
    gemini(parts, 10, true);
    const ex = new GoogleExecutor(config('google', 'gemini-3-flash-preview'));
    const first = await ex.invoke([{ role: 'user', content: 'go' }]);
    if (legacy) delete first.message.nativeState;
    return { ex, first };
  }
  it('preserves untouched parallel calls exactly without an import sentinel', async () => {
    const { ex, first } = await firstTurn();
    const result = await ex.invoke([first.message]);
    expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual(parts);
    expect(result.inputTransformations).toBeUndefined();
  });
  it('imports a retained unsigned sibling after the first signed call is removed without moving its signature', async () => {
    const { ex, first } = await firstTurn(); const snapshot = JSON.stringify(first.message.nativeState || first.message.rawParts);
    first.message.tool_calls = [first.message.tool_calls![1]];
    const result = await ex.invoke([first.message, { role: 'tool', tool_call_id: 'weather', content: '{"city":"London"}' }]);
    expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual([{ ...parts[1], thoughtSignature: 'skip_thought_signature_validator' }]);
    expect(result.inputTransformations).toEqual([{ type: 'imported_history', path: 'contents.0.parts.0', reason: 'canonical_tool_history_changed' }]);
    expect(JSON.stringify(first.message.nativeState || first.message.rawParts)).toBe(snapshot);
  });
  it('preserves the signed surviving call when only the unsigned sibling is removed', async () => {
    const { ex, first } = await firstTurn(); first.message.tool_calls = [first.message.tool_calls![0]];
    const result = await ex.invoke([first.message]);
    expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual([parts[0]]);
    expect(result.inputTransformations).toBeUndefined();
  });
  it('uses an import sentinel for a changed signed call argument', async () => {
    const { ex, first } = await firstTurn(); first.message.tool_calls![0].args.city = 'Rome';
    const result = await ex.invoke([first.message]);
    expect(googleStream.mock.lastCall![0].contents[0].parts).toEqual([{ functionCall: { name: 'weather', args: { city: 'Rome' } }, thoughtSignature: 'skip_thought_signature_validator' }, parts[1]]);
    expect(result.inputTransformations).toEqual([{ type: 'imported_history', path: 'contents.0.parts.0', reason: 'canonical_tool_history_changed' }]);
  });
});

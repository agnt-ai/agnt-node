import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../cli/utils/credentials.js', () => ({ resolveProfile: async () => ({ apiUrl: 'https://api.test', apiKey: 'ak_test' }) }));
import { runListCalls, runGetCall } from '../cli/commands/run.js';
let fetchMock: ReturnType<typeof vi.fn>, output: string[];
beforeEach(() => {
  output = []; fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { output.push(args.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => { throw Error(`exit:${code}`); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const respond = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
describe('native call diagnostics CLI', () => {
  it('lists task-linked calls with account credentials and honest truncation', async () => {
    respond({ ok: true, callTraces: [{ callId: 'CA123', status: 'ended', provider: 'azure-live' }], limit: 1, truncated: true });
    await runListCalls({ task: 'task-1', limit: '1' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.test/voice/call-traces?task=task-1&limit=1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ak_test');
    expect(output.join('\n')).toContain('may be truncated');
  });
  it('retrieves actual setup, speaker/reasoner snapshots, transcript and exported LangSmith URL', async () => {
    const trace = { _id: 'session', callId: 'CA1', snapshot: { speaker: { content: 'Hello Shaun' } }, gateway: { setup: { session: { instructions: 'Hello Shaun' } } }, transcript: [{ role: 'assistant', content: 'order' }] };
    respond({ ok: true, callTrace: trace }); respond({ ok: true, url: 'https://smith.langchain.com/trace' });
    await runGetCall('CA1', { json: true, langsmith: true });
    expect(JSON.parse(output[0])).toEqual({ callTrace: trace, langsmithUrl: 'https://smith.langchain.com/trace' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/voice/call-traces/CA1/langsmith-url');
  });
  it('reports missing historical records instead of inventing captured instructions', async () => {
    respond({ error: 'No retroactive prompt capture' }, 404);
    await expect(runGetCall('old', { json: true })).rejects.toThrow('exit:1');
    expect(output.join('\n')).toContain('404'); expect(output.join('\n')).toContain('No retroactive prompt capture');
  });
  it('rejects invalid limits without a network request', async () => {
    await expect(runListCalls({ limit: 'NaN' })).rejects.toThrow('exit:1'); expect(fetchMock).not.toHaveBeenCalled();
  });
});

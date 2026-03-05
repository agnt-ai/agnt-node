import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTrace } from '../tracing.js';
import type { TracePayload } from '../tracing.js';

const mockPayload: TracePayload = {
  promptName: 'test/prompt',
  manifest: {} as any,
  etag: 'etag-123',
  variables: {},
  messages: [],
  output: 'result',
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  cost: 0.01,
  duration: 1200,
  model: { provider: 'anthropic', name: 'claude-3-haiku', metadata: {} },
  status: 'success',
  metadata: {},
  tags: []
};

const log = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  log.mockReset();
});

describe('sendTrace', () => {
  it('does nothing when tracing is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await sendTrace({ enabled: false, apiUrl: 'https://api.agnt.ai', serviceKey: 'sk' }, mockPayload, log);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing when tracing config is falsy', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await sendTrace(null as any, mockPayload, log);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('logs and returns when apiUrl is missing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await sendTrace({ enabled: true, apiUrl: '', serviceKey: 'sk' }, mockPayload, log);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Missing required config'));
  });

  it('logs and returns when serviceKey is missing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await sendTrace({ enabled: true, apiUrl: 'https://api.agnt.ai', serviceKey: '' }, mockPayload, log);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Missing required config'));
  });

  it('calls POST /traces with Bearer token when enabled', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('')
    });
    vi.stubGlobal('fetch', mockFetch);

    await sendTrace(
      { enabled: true, apiUrl: 'https://api.agnt.ai', serviceKey: 'sk_test' },
      mockPayload,
      log
    );

    // fetch is fire-and-forget; give the microtask queue a tick
    await new Promise(r => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.agnt.ai/traces',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer sk_test' })
      })
    );
  });

  it('logs trace failure on non-OK response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('Unauthorized')
    });
    vi.stubGlobal('fetch', mockFetch);

    await sendTrace(
      { enabled: true, apiUrl: 'https://api.agnt.ai', serviceKey: 'sk_bad' },
      mockPayload,
      log
    );

    await new Promise(r => setTimeout(r, 10));

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Trace failed'), 'Unauthorized');
  });
});

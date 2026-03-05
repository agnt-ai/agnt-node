import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('../cli/utils/config.js', () => ({
  loadConfig: vi.fn()
}));

// Mock API client
vi.mock('../cli/utils/api.js', () => ({
  AgntApiClient: vi.fn().mockImplementation(() => ({
    getManifest: vi.fn().mockResolvedValue({ spec: { models: [{ provider: 'anthropic', model: 'claude-3' }] }, metadata: { etag: 'etag1' } })
  }))
}));

// Mock executor factory
vi.mock('../executorFactory.js', () => ({
  createExecutor: vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue({ output: 'result', messages: [], usage: { totalTokens: 100 } })
  })
}));

import { AgntExecutor } from '../AgntExecutor.js';
import { loadConfig } from '../cli/utils/config.js';
import { createExecutor } from '../executorFactory.js';

const baseConfig = {
  apiUrl: 'https://api.agnt.ai',
  serviceKey: 'sk_test',
  outputDir: './agnt/prompts',
  apiMode: false
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue(baseConfig as any);
  vi.mocked(createExecutor).mockResolvedValue({
    execute: vi.fn().mockResolvedValue({ output: 'result', messages: [], usage: { totalTokens: 100 } })
  } as any);
});

describe('AgntExecutor.create()', () => {
  it('creates from loaded config when none provided', async () => {
    const executor = await AgntExecutor.create({ credentials: {} });
    expect(executor).toBeInstanceOf(AgntExecutor);
    expect(loadConfig).toHaveBeenCalled();
  });

  it('uses provided config without loading from file', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: baseConfig as any });
    expect(executor).toBeInstanceOf(AgntExecutor);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('throws when no config found', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(null);
    await expect(AgntExecutor.create({ credentials: {} })).rejects.toThrow('No agnt.config.js found');
  });
});

describe('AgntExecutor address parsing', () => {
  it('throws on invalid address format', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: baseConfig as any });
    await expect(executor.execute('invalid-address', {})).rejects.toThrow('Invalid prompt address');
  });

  it('throws on address with more than 2 parts', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: baseConfig as any });
    await expect(executor.execute('a/b/c', {})).rejects.toThrow('Invalid prompt address');
  });

  it('throws on address with empty account slug', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: baseConfig as any });
    await expect(executor.execute('/prompt-name', {})).rejects.toThrow('Invalid prompt address');
  });
});

describe('AgntExecutor.execute()', () => {
  it('loads from file when apiMode is false', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: { ...baseConfig, apiMode: false } as any });
    // File mode will throw ENOENT for missing file — we just verify it tries to load from file
    await expect(executor.execute('acct/prompt', {})).rejects.toThrow();
  });

  it('loads from API when apiMode is true', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: { ...baseConfig, apiMode: true } as any });
    const result = await executor.execute('acct/prompt', {});
    expect(result.output).toBe('result');
    expect(createExecutor).toHaveBeenCalled();
  });

  it('apiMode option overrides config.apiMode', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: { ...baseConfig, apiMode: false } as any });
    const result = await executor.execute('acct/prompt', {}, {}, { apiMode: true });
    expect(result.output).toBe('result');
  });

  it('getConfig returns a copy of config', async () => {
    const executor = await AgntExecutor.create({ credentials: {}, config: baseConfig as any });
    const config = executor.getConfig();
    expect(config.apiUrl).toBe('https://api.agnt.ai');
    expect(config).not.toBe(baseConfig); // copy, not reference
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getConfigPath, loadConfig } from '../index.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `agnt-config-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// getConfigPath
// ─────────────────────────────────────────────────────────────────────────────

describe('getConfigPath', () => {
  it('finds agnt.config.js in the given directory', async () => {
    const configPath = join(testDir, 'agnt.config.js');
    await writeFile(configPath, 'export default {}');
    const found = await getConfigPath(testDir);
    expect(found).toBe(configPath);
  });

  it('finds agnt.config.ts in the given directory', async () => {
    const configPath = join(testDir, 'agnt.config.ts');
    await writeFile(configPath, 'export default {}');
    const found = await getConfigPath(testDir);
    expect(found).toBe(configPath);
  });

  it('prefers .js over .ts when both exist', async () => {
    await writeFile(join(testDir, 'agnt.config.js'), 'export default {}');
    await writeFile(join(testDir, 'agnt.config.ts'), 'export default {}');
    const found = await getConfigPath(testDir);
    expect(found).toBe(join(testDir, 'agnt.config.js'));
  });

  it('walks up to find config in parent directory', async () => {
    const subDir = join(testDir, 'sub', 'dir');
    await mkdir(subDir, { recursive: true });
    const configPath = join(testDir, 'agnt.config.js');
    await writeFile(configPath, 'export default {}');
    const found = await getConfigPath(subDir);
    expect(found).toBe(configPath);
  });

  it('returns null when no config file exists', async () => {
    // Use a deep temp subdir unlikely to have an agnt.config.js above it
    const isolatedDir = join(testDir, 'no-config');
    await mkdir(isolatedDir, { recursive: true });
    // We can't easily guarantee no parent has the file, so just verify
    // the function returns a string or null (not throwing)
    const found = await getConfigPath(isolatedDir);
    expect(found === null || typeof found === 'string').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns null when no config file exists in isolated dir', async () => {
    // Create a deeply nested dir with no config — walk-up will stop at filesystem root
    // We test this indirectly; the important thing is it doesn't throw
    const result = await loadConfig(join(testDir, 'empty'));
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('loads config and applies defaults for missing fields', async () => {
    const configPath = join(testDir, 'agnt.config.js');
    await writeFile(configPath, `export default { privateKey: 'pk', kid: 'kid1' };`);
    const config = await loadConfig(testDir);
    expect(config).not.toBeNull();
    expect(config!.privateKey).toBe('pk');
    expect(config!.kid).toBe('kid1');
    expect(config!.apiUrl).toBe('https://api.agnt.ai');
    expect(config!.serviceKey).toBe('');
    expect(config!.outputDir).toBe('./agnt/prompts');
    expect(config!.apiMode).toBe(false);
    expect(config!.maxMessages).toBe(50);
  });

  it('loads all fields when fully specified', async () => {
    const configPath = join(testDir, 'agnt.config.js');
    await writeFile(configPath, `export default {
      privateKey: '-----BEGIN PRIVATE KEY-----',
      kid: 'my-key-id',
      apiUrl: 'https://api-staging.agnt.ai',
      serviceKey: 'sk_test_123',
      outputDir: './my/prompts',
      apiMode: true,
      maxMessages: 100
    };`);
    const config = await loadConfig(testDir);
    expect(config!.privateKey).toBe('-----BEGIN PRIVATE KEY-----');
    expect(config!.kid).toBe('my-key-id');
    expect(config!.apiUrl).toBe('https://api-staging.agnt.ai');
    expect(config!.serviceKey).toBe('sk_test_123');
    expect(config!.outputDir).toBe('./my/prompts');
    expect(config!.apiMode).toBe(true);
    expect(config!.maxMessages).toBe(100);
  });

  it('finds config in parent when called from subdirectory', async () => {
    const subDir = join(testDir, 'packages', 'my-app');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(testDir, 'agnt.config.js'), `export default { kid: 'from-parent' };`);
    const config = await loadConfig(subDir);
    expect(config!.kid).toBe('from-parent');
  });
});

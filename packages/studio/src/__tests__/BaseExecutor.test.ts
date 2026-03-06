/**
 * BaseExecutor unit tests
 *
 * Tests rendering, component resolution, and logLevel behaviour
 * without making any LLM API calls.
 */

import { describe, it, expect, vi } from 'vitest';
import BaseExecutor from '../BaseExecutor.js';
import type { BaseExecutorConfig, PromptManifestV2 } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<PromptManifestV2> = {}): PromptManifestV2 {
  return {
    $schema: 'https://agnt.ai/schemas/manifest/v2.json',
    kind: 'PromptManifest',
    apiVersion: 'v2',
    metadata: { name: 'test', title: 'Test', description: '' },
    spec: {
      routingStrategy: 'fallback',
      enableToolCalls: false,
      variables: [],
      files: [],
      tools: [],
      models: [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }],
      dependencies: [],
    },
    ...overrides,
  };
}

function makeConfig(manifest: PromptManifestV2, overrides: Partial<BaseExecutorConfig> = {}): BaseExecutorConfig {
  return {
    manifest,
    credentials: { anthropic: { apiKey: 'test' } },
    ...overrides,
  };
}

// Concrete subclass so we can instantiate BaseExecutor and call protected methods
class TestExecutor extends BaseExecutor {
  invoke = vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, usage: { input_tokens: 1, output_tokens: 1 } });
  hasToolCalls = vi.fn().mockReturnValue(false);

  // Expose protected methods for testing
  testPopulateTemplate(template: string, variables: Record<string, any>) {
    return this.populateTemplate(template, variables);
  }

  testRenderBlock(block: any) {
    return this.renderBlock(block);
  }

  testRenderSection(section: 'system' | 'messages') {
    return this.renderSection(section);
  }

  getLog() { return this.log; }
  getDebug() { return this.debug; }
}

// ─────────────────────────────────────────────────────────────────────────────
// populateTemplate — component resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('populateTemplate — component resolution', () => {
  it('resolves a standalone {component.name} reference', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [{ name: 'intro', content: 'Hello from intro' }],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    expect(ex.testPopulateTemplate('{component.intro}', {})).toBe('Hello from intro');
  });

  it('resolves an inline {component.name} embedded in surrounding text', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [{ name: 'conversation', content: 'Messages go here' }],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    const result = ex.testPopulateTemplate('## Conversation\n\n{component.conversation}', {});
    expect(result).toBe('## Conversation\n\nMessages go here');
  });

  it('substitutes variables inside resolved component content', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [{ name: 'greeting', content: 'Hello, {userName}!' }],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest, { variables: { userName: 'Alice' } }));
    expect(ex.testPopulateTemplate('{component.greeting}', { userName: 'Alice' })).toBe('Hello, Alice!');
  });

  it('leaves unknown component ref unchanged', () => {
    const manifest = makeManifest({
      resolvedDependencies: { components: [], assistants: [], skills: [] },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    expect(ex.testPopulateTemplate('{component.missing}', {})).toBe('{component.missing}');
  });

  it('resolves multiple component refs in one template', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [
          { name: 'header', content: '# Title' },
          { name: 'footer', content: '---' },
        ],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    const result = ex.testPopulateTemplate('{component.header}\n\nbody\n\n{component.footer}', {});
    expect(result).toBe('# Title\n\nbody\n\n---');
  });

  it('still resolves regular variables alongside component refs', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [{ name: 'intro', content: 'Intro block' }],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    const result = ex.testPopulateTemplate('{component.intro}\n\n{now}', { now: 'Monday' });
    expect(result).toBe('Intro block\n\nMonday');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderBlock — component_ref type
// ─────────────────────────────────────────────────────────────────────────────

describe('renderBlock — component_ref', () => {
  it('renders a component_ref block using resolvedDependencies', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [{ name: 'personality', content: 'Be friendly.' }],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    const result = ex.testRenderBlock({ type: 'component_ref', order: 0, componentName: 'personality' });
    expect(result).toBe('Be friendly.');
  });

  it('returns empty string when component_ref target is not found', () => {
    const manifest = makeManifest({
      resolvedDependencies: { components: [], assistants: [], skills: [] },
    });
    const ex = new TestExecutor(makeConfig(manifest));
    expect(ex.testRenderBlock({ type: 'component_ref', order: 0, componentName: 'nonexistent' })).toBe('');
  });

  it('substitutes variables in component_ref content', () => {
    const manifest = makeManifest({
      resolvedDependencies: {
        components: [{ name: 'now', content: 'Current time: {now}' }],
        assistants: [],
        skills: [],
      },
    });
    const ex = new TestExecutor(makeConfig(manifest, { variables: { now: '3pm' } }));
    expect(ex.testRenderBlock({ type: 'component_ref', order: 0, componentName: 'now' })).toBe('Current time: 3pm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// logLevel
// ─────────────────────────────────────────────────────────────────────────────

describe('logLevel', () => {
  it('logLevel=info: log fires, debug does not', () => {
    const log = vi.fn();
    const ex = new TestExecutor(makeConfig(makeManifest(), { log, logLevel: 'info' }));
    ex.getLog()('hello');
    ex.getDebug()('verbose');
    expect(log).toHaveBeenCalledWith('hello');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logLevel=debug: both log and debug fire', () => {
    const log = vi.fn();
    const ex = new TestExecutor(makeConfig(makeManifest(), { log, logLevel: 'debug' }));
    ex.getLog()('hello');
    ex.getDebug()('verbose');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('logLevel=silent: neither log nor debug fires', () => {
    const log = vi.fn();
    const ex = new TestExecutor(makeConfig(makeManifest(), { log, logLevel: 'silent' }));
    ex.getLog()('hello');
    ex.getDebug()('verbose');
    expect(log).not.toHaveBeenCalled();
  });

  it('defaults to info when logLevel is not specified', () => {
    const log = vi.fn();
    const ex = new TestExecutor(makeConfig(makeManifest(), { log }));
    ex.getLog()('hello');
    ex.getDebug()('verbose');
    expect(log).toHaveBeenCalledTimes(1);
  });
});

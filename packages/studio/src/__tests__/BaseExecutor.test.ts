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

  testCalculateCost(
    inputTokensOrUsage: number | { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
    outputTokens: number
  ) {
    return this.calculateCost(inputTokensOrUsage, outputTokens);
  }

  getLog() { return this.log; }
  getDebug() { return this.debug; }

  testNormalizeToolArgs(name: string, args: Record<string, any>) {
    return this.normalizeToolArgs(name, args);
  }

  testHandleToolCalls(toolCalls: any[]) {
    return this.handleToolCalls(toolCalls);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// calculateCost — provider-agnostic, cache-aware (four-term formula)
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateCost — cache-aware, provider-agnostic', () => {
  const pricing = {
    provider: 'anthropic',
    name: 'claude-sonnet-4-5',
    inputTokensPer1M: 3,
    outputTokensPer1M: 15,
    cacheCreationTokensPer1M: 3.75,
    cacheReadTokensPer1M: 0.3,
    currency: 'USD',
  };

  function exWith(modelPricing?: any) {
    return new TestExecutor(makeConfig(makeManifest(), { modelPricing, logLevel: 'silent' }));
  }

  it('prices all four buckets from the catalog rates', () => {
    const ex = exWith(pricing);
    const cost = ex.testCalculateCost(
      { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
      1_000_000
    );
    // 3 + 3.75 + 0.3 + 15 = 22.05
    expect(cost).toBeCloseTo(22.05, 6);
  });

  it('a null cache rate contributes 0 (OpenAI-style: no cache-creation charge)', () => {
    const ex = exWith({
      provider: 'openai',
      name: 'gpt-4o',
      inputTokensPer1M: 2.5,
      outputTokensPer1M: 10,
      cacheCreationTokensPer1M: null, // provider does not bill cache creation
      cacheReadTokensPer1M: 1.25,
      currency: 'USD',
    });
    const cost = ex.testCalculateCost(
      { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
      0
    );
    // 2.5 (input) + 0 (creation null) + 1.25 (read) = 3.75
    expect(cost).toBeCloseTo(3.75, 6);
  });

  it('both cache rates null/undefined ⇒ cache buckets contribute 0', () => {
    const ex = exWith({
      provider: 'google',
      name: 'gemini-2.0',
      inputTokensPer1M: 1,
      outputTokensPer1M: 4,
      cacheCreationTokensPer1M: null,
      cacheReadTokensPer1M: null,
      currency: 'USD',
    });
    const cost = ex.testCalculateCost(
      { input_tokens: 2_000_000, cache_creation_input_tokens: 5_000_000, cache_read_input_tokens: 9_000_000 },
      500_000
    );
    // only input + output: 2*1 + 0.5*4 = 4
    expect(cost).toBeCloseTo(4, 6);
  });

  it('numeric input form prices input + output only (no cache)', () => {
    const ex = exWith(pricing);
    const cost = ex.testCalculateCost(2_000_000, 1_000_000);
    // 2*3 + 1*15 = 21
    expect(cost).toBeCloseTo(21, 6);
  });

  it('does not apply Anthropic cache multipliers when catalog cache rates are absent', () => {
    // No modelPricing at all → input/output safety defaults (3/15) apply,
    // but cache rates must be 0, NOT inRate*1.25 / inRate*0.10.
    const ex = exWith(undefined);
    const cost = ex.testCalculateCost(
      { input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
      0
    );
    expect(cost).toBeCloseTo(0, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeToolArgs — schema-aware stringified arg coercion (direct-call boundary)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeToolArgs — schema-aware arg coercion', () => {
  // Manifest with a tool whose schema declares array/object/string/number params.
  function toolManifest() {
    return makeManifest({
      spec: {
        routingStrategy: 'fallback',
        enableToolCalls: true,
        variables: [],
        files: [],
        models: [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }],
        dependencies: [],
        tools: [
          {
            name: 'contact_lookup',
            description: 'lookup',
            parameters: {
              type: 'object',
              properties: {
                emails:  { type: 'array',  items: { type: 'string' } },
                updates: { type: 'object' },
                query:   { type: 'string' },
                limit:   { type: 'number' },
                count:   { type: 'integer' },
                ratio:   { type: 'number' },
                enabled: { type: 'boolean' },
                flexId:  { type: ['string', 'number'] },
                priority: { type: ['integer', 'null'] },
                dispatchIndex: { type: ['array', 'null'] },
              },
            },
          },
        ],
      },
    } as any);
  }

  function ex() {
    return new TestExecutor(makeConfig(toolManifest()));
  }

  it('coerces a stringified array arg to a real array', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { emails: '["a@b.com","c@d.com"]' });
    expect(out.emails).toEqual(['a@b.com', 'c@d.com']);
  });

  it('coerces a stringified object arg to a real object', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { updates: '{"name":"Bob"}' });
    expect(out.updates).toEqual({ name: 'Bob' });
  });

  it('leaves a legitimate string-typed param untouched even if it looks like JSON', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { query: '[1,2,3]' });
    expect(out.query).toBe('[1,2,3]');
    expect(typeof out.query).toBe('string');
  });

  it('leaves a non-JSON string for an array param untouched (clean validation downstream)', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { emails: 'not json at all' });
    expect(out.emails).toBe('not json at all');
  });

  it('passes through an already-correct array unchanged', () => {
    const input = { emails: ['a@b.com'] };
    const out = ex().testNormalizeToolArgs('contact_lookup', input);
    expect(out.emails).toEqual(['a@b.com']);
  });

  it('coerces a numeric string to a number', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { limit: '5' });
    expect(out.limit).toBe(5);
    expect(typeof out.limit).toBe('number');
  });

  it('coerces a decimal string for a number param', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { ratio: '3.14' });
    expect(out.ratio).toBe(3.14);
  });

  it('coerces a negative numeric string', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { ratio: '-2.5' });
    expect(out.ratio).toBe(-2.5);
  });

  it('coerces an integer string for an integer param', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { count: '42' });
    expect(out.count).toBe(42);
  });

  it('does NOT coerce a decimal for an integer param (left for validation)', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { count: '3.5' });
    expect(out.count).toBe('3.5');
  });

  it('does NOT coerce a big-integer string that would lose precision', () => {
    const big = '12345678901234567890'; // > Number.MAX_SAFE_INTEGER — must stay a string
    const out = ex().testNormalizeToolArgs('contact_lookup', { count: big });
    expect(out.count).toBe(big);
    expect(typeof out.count).toBe('string');
  });

  it('does NOT coerce numeric strings with leading zeros, exponents, or whitespace-only', () => {
    expect(ex().testNormalizeToolArgs('contact_lookup', { count: '007' }).count).toBe('007');
    expect(ex().testNormalizeToolArgs('contact_lookup', { ratio: '1e3' }).ratio).toBe('1e3');
    expect(ex().testNormalizeToolArgs('contact_lookup', { ratio: '' }).ratio).toBe('');
    expect(ex().testNormalizeToolArgs('contact_lookup', { ratio: 'NaN' }).ratio).toBe('NaN');
  });

  it('coerces an integer string through a union that includes integer', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { priority: '2' });
    expect(out.priority).toBe(2);
  });

  it('coerces the boolean literals "true" and "false"', () => {
    expect(ex().testNormalizeToolArgs('contact_lookup', { enabled: 'true' }).enabled).toBe(true);
    expect(ex().testNormalizeToolArgs('contact_lookup', { enabled: 'false' }).enabled).toBe(false);
  });

  it('does NOT coerce loose booleans ("yes", "1", "True")', () => {
    expect(ex().testNormalizeToolArgs('contact_lookup', { enabled: 'yes' }).enabled).toBe('yes');
    expect(ex().testNormalizeToolArgs('contact_lookup', { enabled: '1' }).enabled).toBe('1');
    expect(ex().testNormalizeToolArgs('contact_lookup', { enabled: 'True' }).enabled).toBe('True');
  });

  it('never coerces a param whose schema also allows string (union with string)', () => {
    // flexId accepts ["string","number"] — the raw string is already valid, leave it.
    const out = ex().testNormalizeToolArgs('contact_lookup', { flexId: '42' });
    expect(out.flexId).toBe('42');
    expect(typeof out.flexId).toBe('string');
  });

  it('does NOT accept a parsed object when the schema expects an array (type mismatch)', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { emails: '{"x":1}' });
    expect(out.emails).toBe('{"x":1}'); // parse succeeded but type wrong → untouched
  });

  it('honors a union type that includes array', () => {
    const out = ex().testNormalizeToolArgs('contact_lookup', { dispatchIndex: '[0,1]' });
    expect(out.dispatchIndex).toEqual([0, 1]);
  });

  it('does not mutate the caller args object in place', () => {
    const input: Record<string, any> = { emails: '["a@b.com"]' };
    const out = ex().testNormalizeToolArgs('contact_lookup', input);
    expect(input.emails).toBe('["a@b.com"]'); // original untouched
    expect(out.emails).toEqual(['a@b.com']);
  });

  it('leaves args untouched for an unknown tool with no schema', () => {
    const input = { emails: '["a@b.com"]' };
    const out = ex().testNormalizeToolArgs('no_such_tool', input);
    expect(out.emails).toBe('["a@b.com"]');
  });

  it('normalizes through handleToolCalls before dispatch to the handler', async () => {
    let received: any;
    const router = {
      contact_lookup: { execute: async (args: any) => { received = args; return { completed: true }; } },
    };
    const executor = new TestExecutor(makeConfig(toolManifest(), { toolRouter: router }));
    await executor.testHandleToolCalls([
      { id: 't1', name: 'contact_lookup', args: { emails: '["a@b.com"]', updates: '{"k":1}', query: '[9]' } },
    ]);
    expect(received.emails).toEqual(['a@b.com']);   // string→array
    expect(received.updates).toEqual({ k: 1 });     // string→object
    expect(received.query).toBe('[9]');             // string param left alone
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isRetryableError — transient-fault classification for model fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('isRetryableError — transient faults retry, client errors do not', () => {
  const ex = () => new TestExecutor(makeConfig(makeManifest())) as any;

  it('retries any 5xx, including gateway/CDN codes not explicitly enumerated', () => {
    const e = ex();
    for (const status of [500, 502, 503, 504, 520, 522, 524, 529]) {
      expect(e.isRetryableError({ status }), `status ${status}`).toBe(true);
    }
  });

  it('retries 429 (rate limit), 408 (timeout), and 425 (too early)', () => {
    const e = ex();
    for (const status of [429, 408, 425]) {
      expect(e.isRetryableError({ status }), `status ${status}`).toBe(true);
    }
  });

  it('does NOT retry 4xx client errors (auth/validation/not-found)', () => {
    const e = ex();
    for (const status of [400, 401, 403, 404, 422]) {
      expect(e.isRetryableError({ status }), `status ${status}`).toBe(false);
    }
  });

  it('retries Anthropic SDK typed errors by constructor name', () => {
    const e = ex();
    class OverloadedError extends Error {}
    class RateLimitError extends Error {}
    expect(e.isRetryableError(new OverloadedError('overloaded'))).toBe(true);
    expect(e.isRetryableError(new RateLimitError('429'))).toBe(true);
  });

  it('retries Node network error codes', () => {
    const e = ex();
    expect(e.isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(e.isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('does not retry a plain unknown error', () => {
    expect(ex().isRetryableError(new Error('something specific went wrong'))).toBe(false);
  });
});

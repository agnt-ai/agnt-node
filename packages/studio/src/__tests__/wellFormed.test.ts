import { describe, it, expect } from 'vitest';
import { wellFormString, deepWellForm } from '../wellFormed.js';

// A lone high surrogate (\uD83D is the lead unit of 😀 😀).
const LONE_HIGH = 'hi \uD83D';
// A lone low surrogate.
const LONE_LOW = '\uDE00 there';
// A well-formed emoji (valid surrogate pair) must be preserved untouched.
const EMOJI = 'gm 😀 team';

describe('wellFormString', () => {
  it('replaces a lone high surrogate with U+FFFD', () => {
    const out = wellFormString(LONE_HIGH);
    expect(out).toBe('hi �');
    // And the result is JSON-serializable without throwing / producing invalid JSON.
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.parse(JSON.stringify(out))).toBe('hi �');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    expect(wellFormString(LONE_LOW)).toBe('� there');
  });

  it('leaves valid surrogate pairs (real emoji) untouched', () => {
    expect(wellFormString(EMOJI)).toBe(EMOJI);
  });

  it('returns the SAME reference when already well-formed (no allocation)', () => {
    const s = 'plain ascii and 😀 astral';
    expect(wellFormString(s)).toBe(s);
  });

  it('handles a truncation that split an emoji mid-pair', () => {
    // Simulate `('...😀'.slice(0, n))` cutting between the two code units.
    const full = 'meeting 😀';
    const truncated = full.slice(0, full.length - 1); // drops the low half
    expect(truncated.endsWith('\uD83D')).toBe(true);
    expect(wellFormString(truncated)).toBe('meeting �');
  });
});

describe('deepWellForm', () => {
  it('well-forms strings nested in objects and arrays', () => {
    const input = {
      role: 'user',
      content: [
        { type: 'text', text: LONE_HIGH },
        { type: 'text', text: EMOJI },
      ],
      meta: { note: LONE_LOW },
    };
    const out = deepWellForm(input);
    expect(out.content[0].text).toBe('hi �');
    expect(out.content[1].text).toBe(EMOJI);
    expect(out.meta.note).toBe('� there');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('returns the SAME reference when nothing changed (copy-on-write)', () => {
    const clean = { a: 'x', b: ['y', { c: 'z 😀' }] };
    expect(deepWellForm(clean)).toBe(clean);
  });

  it('clones only along the path that changed', () => {
    const cleanBranch = { c: 'clean 😀' };
    const input = { dirty: LONE_HIGH, clean: cleanBranch };
    const out = deepWellForm(input);
    expect(out).not.toBe(input); // root cloned (a descendant changed)
    expect(out.dirty).toBe('hi �');
    expect(out.clean).toBe(cleanBranch); // untouched branch keeps its reference
  });

  it('passes through primitives and null unchanged', () => {
    expect(deepWellForm(42)).toBe(42);
    expect(deepWellForm(true)).toBe(true);
    expect(deepWellForm(null)).toBe(null);
    expect(deepWellForm(undefined)).toBe(undefined);
  });
});

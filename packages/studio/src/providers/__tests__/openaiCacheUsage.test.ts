import { describe, it, expect } from 'vitest';
import { openaiCacheBuckets } from '../openaiCacheUsage.js';

describe('openaiCacheBuckets', () => {
  it('splits a prompt total into disjoint uncached / read / written buckets', () => {
    expect(openaiCacheBuckets(10_000, { cached_tokens: 6_000, cache_write_tokens: 3_500 }))
      .toEqual({ input_tokens: 500, cache_read_input_tokens: 6_000, cache_creation_input_tokens: 3_500 });
  });
  it('older models (no cache_write_tokens) keep the read-only behaviour', () => {
    expect(openaiCacheBuckets(2_000, { cached_tokens: 1_024 }))
      .toEqual({ input_tokens: 976, cache_read_input_tokens: 1_024, cache_creation_input_tokens: 0 });
    expect(openaiCacheBuckets(2_000, undefined))
      .toEqual({ input_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
  it('never reports more written than the uncached remainder', () => {
    expect(openaiCacheBuckets(1_000, { cached_tokens: 900, cache_write_tokens: 500 }))
      .toEqual({ input_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 });
  });
});

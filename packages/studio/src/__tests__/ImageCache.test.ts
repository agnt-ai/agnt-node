import { describe, it, expect, vi, beforeEach } from 'vitest';
import ImageCache from '../ImageCache.js';

let cache: ImageCache;

beforeEach(() => {
  cache = new ImageCache({ log: vi.fn() });
});

describe('ImageCache', () => {
  describe('set() and get()', () => {
    it('stores and retrieves an image for a provider', () => {
      cache.set('https://example.com/image.jpg', 'anthropic', 'data:image/jpeg;base64,abc');
      const result = cache.get('https://example.com/image.jpg', 'anthropic');
      expect(result).toBe('data:image/jpeg;base64,abc');
    });

    it('returns null for unknown provider', () => {
      cache.set('https://example.com/image.jpg', 'anthropic', 'data:...');
      expect(cache.get('https://example.com/image.jpg', 'openai')).toBeNull();
    });

    it('returns null for unknown image source', () => {
      expect(cache.get('https://other.com/image.png', 'anthropic')).toBeNull();
    });

    it('stores multiple providers for same image', () => {
      const url = 'https://example.com/img.jpg';
      cache.set(url, 'anthropic', 'anthropic-format');
      cache.set(url, 'openai', 'openai-format');
      expect(cache.get(url, 'anthropic')).toBe('anthropic-format');
      expect(cache.get(url, 'openai')).toBe('openai-format');
    });

    it('handles image_url object format', () => {
      const src = { image_url: 'https://example.com/img.jpg' };
      cache.set(src, 'anthropic', 'processed');
      expect(cache.get(src, 'anthropic')).toBe('processed');
    });

    it('handles image_url.url nested format', () => {
      const src = { image_url: { url: 'https://example.com/img.jpg' } };
      cache.set(src, 'openai', 'processed-openai');
      expect(cache.get(src, 'openai')).toBe('processed-openai');
    });

    it('handles bedrock bytes format', () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const src = { image: { source: { bytes } } };
      cache.set(src, 'bedrock', { type: 'image', image: { format: 'jpeg' } });
      const result = cache.get(src, 'bedrock');
      expect(result).toEqual({ type: 'image', image: { format: 'jpeg' } });
    });
  });

  describe('has()', () => {
    it('returns true when image is cached for provider', () => {
      cache.set('https://example.com/img.jpg', 'anthropic', 'data');
      expect(cache.has('https://example.com/img.jpg', 'anthropic')).toBe(true);
    });

    it('returns false when image is not cached', () => {
      expect(cache.has('https://example.com/img.jpg', 'anthropic')).toBe(false);
    });

    it('returns false for different provider', () => {
      cache.set('https://example.com/img.jpg', 'anthropic', 'data');
      expect(cache.has('https://example.com/img.jpg', 'openai')).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when maxCacheSize is exceeded', () => {
      const small = new ImageCache({ log: vi.fn(), maxCacheSize: 2 });
      small.set('https://img1.com/a.jpg', 'anthropic', 'img1');
      small.set('https://img2.com/b.jpg', 'anthropic', 'img2');
      small.set('https://img3.com/c.jpg', 'anthropic', 'img3');
      // img1 should have been evicted
      expect(small.get('https://img1.com/a.jpg', 'anthropic')).toBeNull();
      expect(small.get('https://img3.com/c.jpg', 'anthropic')).toBe('img3');
    });
  });

  describe('getStats()', () => {
    it('tracks hits and misses', () => {
      cache.set('https://example.com/img.jpg', 'anthropic', 'data');
      cache.get('https://example.com/img.jpg', 'anthropic'); // hit
      cache.get('https://example.com/img.jpg', 'openai');   // miss
      cache.get('https://other.com/img.jpg', 'anthropic');   // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.stores).toBe(1);
    });

    it('computes hitRate correctly', () => {
      cache.set('https://example.com/img.jpg', 'anthropic', 'data');
      cache.get('https://example.com/img.jpg', 'anthropic'); // hit
      cache.get('https://example.com/img.jpg', 'anthropic'); // hit
      cache.get('https://other.com/img.jpg', 'anthropic');   // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBe('66.67%');
    });

    it('returns 0% hit rate when no accesses', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe('0%');
    });
  });

  describe('clear()', () => {
    it('removes all cached entries', () => {
      cache.set('https://example.com/img.jpg', 'anthropic', 'data');
      cache.clear();
      expect(cache.get('https://example.com/img.jpg', 'anthropic')).toBeNull();
      expect(cache.getStats().cacheSize).toBe(0);
    });
  });

  describe('resetStats()', () => {
    it('resets hit/miss/store/eviction counters', () => {
      cache.set('https://example.com/img.jpg', 'anthropic', 'data');
      cache.get('https://example.com/img.jpg', 'anthropic');
      cache.resetStats();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.stores).toBe(0);
    });
  });
});

import crypto from "crypto";

interface ImageCacheConfig {
  log?: (message: string, ...args: any[]) => void;
  maxCacheSize?: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
}

interface CacheStatsWithRates extends CacheStats {
  hitRate: string;
  cacheSize: number;
  maxSize: number;
}

interface ProviderStats {
  anthropic: number;
  openai: number;
  bedrock: number;
  deepseek: number;
}

interface MemorySize {
  bytes: number;
  kb: string;
  mb: string;
}

/**
 * ImageCache - Caches processed images per provider format
 *
 * Prevents reprocessing the same image when switching providers multiple times.
 * Stores images in multiple formats (anthropic, openai, bedrock) keyed by source URL.
 *
 * Example:
 * - Original: https://example.com/image.jpg
 * - Cache stores:
 *   - anthropic: "data:image/jpeg;base64,..."
 *   - openai: "data:image/jpeg;base64,..." (or original URL)
 *   - bedrock: { type: "image", image: { format: "jpeg", source: { bytes: Uint8Array } } }
 *
 * Cache key: SHA256 hash of source URL for consistent lookup
 */
export default class ImageCache {
  private log: (message: string, ...args: any[]) => void;
  private maxCacheSize: number;
  private cache: Map<string, Record<string, any>>;
  private stats: CacheStats;

  constructor({ log, maxCacheSize = 100 }: ImageCacheConfig = {}) {
    this.log = log || console.log;
    this.maxCacheSize = maxCacheSize;

    // Cache structure: { [imageKey]: { [provider]: processedImage } }
    // imageKey = hash of source URL/content
    // provider = "anthropic" | "openai" | "bedrock" | "deepseek"
    this.cache = new Map();

    // Track cache statistics
    this.stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      evictions: 0
    };
  }

  /**
   * Generate cache key from image source
   * Uses SHA256 hash for consistent, collision-resistant keys
   */
  #generateKey(imageSource: any): string | null {
    // Handle different input types
    let sourceString: string;

    if (typeof imageSource === 'string') {
      // URL or data URL
      sourceString = imageSource;
    } else if (imageSource?.image_url) {
      // { image_url: "..." } format
      sourceString = typeof imageSource.image_url === 'string'
        ? imageSource.image_url
        : imageSource.image_url.url;
    } else if (imageSource?.image?.source?.bytes) {
      // Bedrock format - hash the bytes
      const bytes = imageSource.image.source.bytes;
      return crypto.createHash('sha256').update(bytes).digest('hex');
    } else {
      this.log("[ImageCache] Unknown image source format:", typeof imageSource);
      return null;
    }

    // For URLs and data URLs, hash the string
    return crypto.createHash('sha256').update(sourceString).digest('hex');
  }

  /**
   * Get cached image for specific provider
   * Returns null if not found
   */
  get(imageSource: any, provider: string): any | null {
    const key = this.#generateKey(imageSource);
    if (!key) return null;

    const entry = this.cache.get(key);
    if (!entry || !entry[provider]) {
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    this.log(`[ImageCache] HIT - ${provider} (${key.substring(0, 8)}...)`);

    // Update LRU - move to end
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry[provider];
  }

  /**
   * Store processed image for specific provider
   */
  set(imageSource: any, provider: string, processedImage: any): void {
    const key = this.#generateKey(imageSource);
    if (!key) return;

    // Get or create entry for this image
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {};
    }

    // Store processed image for this provider
    entry[provider] = processedImage;

    // Remove old entry if exists (for LRU)
    this.cache.delete(key);

    // Add to end (most recently used)
    this.cache.set(key, entry);

    this.stats.stores++;
    this.log(`[ImageCache] STORE - ${provider} (${key.substring(0, 8)}...)`);

    // Evict oldest if cache is full
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
        this.log(`[ImageCache] EVICT - Cache size exceeded (${firstKey.substring(0, 8)}...)`);
      }
    }
  }

  /**
   * Check if image is cached for specific provider
   */
  has(imageSource: any, provider: string): boolean {
    const key = this.#generateKey(imageSource);
    if (!key) return false;

    const entry = this.cache.get(key);
    return !!(entry && entry[provider]);
  }

  /**
   * Get all cached formats for an image
   * Returns object with available providers
   */
  getAll(imageSource: any): Record<string, any> | null {
    const key = this.#generateKey(imageSource);
    if (!key) return null;

    return this.cache.get(key) || null;
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.log(`[ImageCache] CLEAR - Removed ${size} entries`);
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStatsWithRates {
    const hitRateNum = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : '0';

    return {
      ...this.stats,
      hitRate: `${hitRateNum}%`,
      cacheSize: this.cache.size,
      maxSize: this.maxCacheSize
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      evictions: 0
    };
  }

  /**
   * Get cache size in bytes (approximate)
   * Useful for monitoring memory usage
   */
  getMemorySize(): MemorySize {
    let totalSize = 0;

    for (const entry of this.cache.values()) {
      for (const image of Object.values(entry)) {
        if (typeof image === 'string') {
          // Data URL or regular URL
          totalSize += image.length * 2; // UTF-16 encoding
        } else if (image?.image?.source?.bytes) {
          // Bedrock format
          totalSize += image.image.source.bytes.length;
        } else if (image?.image_url) {
          // OpenAI/Anthropic format
          const url = typeof image.image_url === 'string'
            ? image.image_url
            : image.image_url.url;
          totalSize += url.length * 2;
        }
      }
    }

    return {
      bytes: totalSize,
      kb: (totalSize / 1024).toFixed(2),
      mb: (totalSize / 1024 / 1024).toFixed(2)
    };
  }

  /**
   * Log cache status
   */
  logStatus(): void {
    const stats = this.getStats();
    const memory = this.getMemorySize();

    this.log("[ImageCache] Status:");
    this.log(`  Entries: ${stats.cacheSize}/${stats.maxSize}`);
    this.log(`  Hits: ${stats.hits} | Misses: ${stats.misses} | Hit Rate: ${stats.hitRate}`);
    this.log(`  Stores: ${stats.stores} | Evictions: ${stats.evictions}`);
    this.log(`  Memory: ${memory.mb} MB (${memory.kb} KB)`);
  }

  /**
   * Estimate provider-specific memory usage
   */
  getProviderStats(): ProviderStats {
    const providerCounts: ProviderStats = {
      anthropic: 0,
      openai: 0,
      bedrock: 0,
      deepseek: 0
    };

    for (const entry of this.cache.values()) {
      for (const providerKey of Object.keys(entry)) {
        if (providerCounts[providerKey as keyof ProviderStats] !== undefined) {
          providerCounts[providerKey as keyof ProviderStats]++;
        }
      }
    }

    return providerCounts;
  }
}

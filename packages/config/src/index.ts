/**
 * @agnt-sdk/config
 *
 * Shared configuration for @agnt-sdk packages.
 * All packages read from the same agnt.config.js at the project root.
 */

/** Agnt SDK configuration — loaded from agnt.config.js */
export interface AgntConfig {
  /** RSA private key PEM string — used by @agnt-sdk/client for JWT signing */
  privateKey?: string;
  /** Key ID registered on the Agnt platform — used in JWT header */
  kid?: string;
  /** Agnt API base URL */
  apiUrl: string;
  /** Service key for private/unlisted prompts (studio) */
  serviceKey: string;
  /** Directory where pulled prompt manifests are saved (studio only) */
  outputDir: string;
  /** true = fetch manifests from API on every call; false = use local files */
  apiMode: boolean;
  /** Maximum messages in agent loop before throwing (prevents infinite loops) */
  maxMessages?: number;
}

/**
 * Find agnt.config.js / agnt.config.ts by walking up from cwd.
 */
export async function getConfigPath(cwd?: string): Promise<string | null> {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('Config file operations are only supported in Node.js.');
  }
  const { join, dirname } = await import('path');
  const { access } = await import('fs/promises');

  let dir = cwd || process.cwd();
  while (true) {
    for (const ext of ['js', 'ts']) {
      const p = join(dir, `agnt.config.${ext}`);
      try { await access(p); return p; } catch { /* continue */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load and parse agnt.config.js / agnt.config.ts.
 * Walks up from cwd so all packages in a project share the same config file.
 */
export async function loadConfig(cwd?: string): Promise<AgntConfig | null> {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('Config file operations are only supported in Node.js.');
  }
  const { pathToFileURL } = await import('url');
  const configPath = await getConfigPath(cwd);
  if (!configPath) return null;

  try {
    const mod = await import(pathToFileURL(configPath).href);
    const config = mod.default || mod;
    return {
      privateKey: config.privateKey,
      kid: config.kid,
      apiUrl: config.apiUrl ?? 'https://api.agnt.ai',
      serviceKey: config.serviceKey ?? '',
      outputDir: config.outputDir ?? './agnt/prompts',
      apiMode: config.apiMode ?? false,
      maxMessages: config.maxMessages ?? 50
    };
  } catch (err: any) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

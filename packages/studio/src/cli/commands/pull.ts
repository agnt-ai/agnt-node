/**
 * agnt pull — fetch and save v2 manifest(s) to the local outputDir
 *
 * Usage:
 *   agnt pull skej/contact-collector   # pull one prompt
 *   agnt pull skej/*                   # pull all public from account
 *   agnt pull                          # pull all from config default account
 */

import { loadConfig } from '../utils/config.js';
import { AgntApiClient } from '../utils/api.js';
import type { PromptManifestV2 } from '../../types.js';

export async function runPull(address?: string): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('No agnt.config.js found. Run: agnt init');
    process.exit(1);
  }

  const client = new AgntApiClient({ apiUrl: config.apiUrl, serviceKey: config.serviceKey });

  const { mkdir, writeFile } = await import('fs/promises');
  const { join, resolve } = await import('path');

  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true });

  if (!address) {
    console.error('Usage: agnt pull <accountSlug>/<promptSlug>  OR  agnt pull <accountSlug>/*');
    process.exit(1);
  }

  const isWildcard = address.endsWith('/*');

  if (isWildcard) {
    const accountSlug = address.slice(0, -2);
    console.log(`Pulling all public prompts for account: ${accountSlug}`);
    let prompts: Array<{ name: string }>;
    try {
      prompts = await client.listPublicPrompts(accountSlug);
    } catch (err: any) {
      console.error(`Failed to list prompts: ${err.message}`);
      process.exit(1);
    }

    if (prompts.length === 0) {
      console.log('No public prompts found.');
      return;
    }

    let saved = 0;
    for (const p of prompts) {
      try {
        const manifest = await client.getManifest(accountSlug, p.name);
        await saveManifest(manifest, p.name, outputDir, writeFile, join);
        console.log(`  ✓ ${accountSlug}/${p.name}`);
        saved++;
      } catch (err: any) {
        console.warn(`  ✗ ${accountSlug}/${p.name}: ${err.message}`);
      }
    }
    console.log(`\nPulled ${saved}/${prompts.length} prompts to ${config.outputDir}`);

  } else {
    const parts = address.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.error(`Invalid address: "${address}". Expected "accountSlug/promptSlug"`);
      process.exit(1);
    }
    const [accountSlug, promptSlug] = parts;

    let manifest: PromptManifestV2;
    try {
      manifest = await client.getManifest(accountSlug, promptSlug);
    } catch (err: any) {
      console.error(`Failed to pull ${address}: ${err.message}`);
      process.exit(1);
    }

    await saveManifest(manifest, promptSlug, outputDir, writeFile, join);
    console.log(`Pulled ${address} → ${config.outputDir}/${promptSlug}.json`);
  }
}

async function saveManifest(
  manifest: PromptManifestV2,
  promptSlug: string,
  outputDir: string,
  writeFile: typeof import('fs/promises').writeFile,
  join: typeof import('path').join
): Promise<void> {
  const filename = promptSlug.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const filePath = join(outputDir, `${filename}.json`);
  const payload = { manifest, pulledAt: new Date().toISOString() };
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

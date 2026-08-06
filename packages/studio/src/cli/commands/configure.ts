/**
 * agnt configure — write a named profile to ~/.agnt/credentials
 *
 * Usage:
 *   agnt configure --profile staging --api-url https://staging-api.agnt.ai --api-key ak_live_...
 */

import { saveProfile } from '../utils/credentials.js';

export interface ConfigureOptions {
  profile: string;
  apiUrl: string;
  apiKey: string;
}

export async function runConfigure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiUrl?.trim()) {
    console.error('Usage: agnt configure --profile <name> --api-url <url> --api-key <key>');
    process.exit(1);
  }
  if (!opts.apiKey?.trim()) {
    console.error('Usage: agnt configure --profile <name> --api-url <url> --api-key <key>');
    process.exit(1);
  }

  try {
    await saveProfile(opts.profile, { apiUrl: opts.apiUrl.trim(), apiKey: opts.apiKey.trim() });
  } catch (err: any) {
    console.error(`Failed to save profile: ${err.message}`);
    process.exit(1);
  }

  console.log(`Saved profile "${opts.profile}" to ~/.agnt/credentials`);
}

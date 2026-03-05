/**
 * agnt init — create agnt.config.js in the current directory
 */

import { getConfigPath } from '../utils/config.js';

export async function runInit(): Promise<void> {
  const existing = await getConfigPath();
  if (existing) {
    console.log(`agnt.config.js already exists at: ${existing}`);
    return;
  }

  const { join } = await import('path');
  const { writeFile } = await import('fs/promises');

  const configPath = join(process.cwd(), 'agnt.config.js');

  const template = `/**
 * Agnt Configuration
 *
 * Docs: https://agnt.ai/docs/sdk
 *
 * WARNING: Keep this file out of version control if it contains secrets.
 * Add agnt.config.js to your .gitignore when using serviceKey directly.
 */

export default {
  // Service key for private/unlisted prompts
  // Get yours from: https://app.agnt.ai/settings/api-keys
  serviceKey: process.env.AGNT_SERVICE_KEY || '',

  // Agnt API base URL
  apiUrl: 'https://api.agnt.ai',

  // Directory where pulled prompt manifests are saved
  outputDir: './agnt/prompts',

  // API mode:
  //   false — use local pulled manifests (fast, offline-capable)
  //   true  — fetch manifests from API on every execution (always up-to-date)
  apiMode: false,

  // Maximum messages in the agent loop before throwing (prevents infinite loops)
  maxMessages: 50,
};
`;

  await writeFile(configPath, template, 'utf-8');
  console.log(`Created agnt.config.js`);
  console.log(`Next: agnt pull <accountSlug>/<promptSlug>`);
}

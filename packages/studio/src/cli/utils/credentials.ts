/**
 * Profile-based credentials — ~/.agnt/credentials
 *
 * AWS-CLI-style named profiles, independent of any project's agnt.config.js
 * (that file is a per-project SDK config found by walking up from cwd; these
 * are personal, per-machine debugging credentials used by `agnt run`/`agnt configure`).
 *
 *   [default]
 *   apiUrl = https://api.agnt.ai
 *   apiKey = ak_live_...
 *
 *   [staging]
 *   apiUrl = https://staging-api.agnt.ai
 *   apiKey = ak_live_...
 */

export interface Profile {
  apiUrl: string;
  apiKey: string;
}

function credentialsPath(homedir: string, join: (...parts: string[]) => string): string {
  return join(homedir, '.agnt', 'credentials');
}

function parseCredentials(raw: string): Record<string, Profile> {
  const profiles: Record<string, Profile> = {};
  let current: string | null = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      current = section[1].trim();
      profiles[current] = profiles[current] ?? { apiUrl: '', apiKey: '' };
      continue;
    }

    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && current) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (key === 'apiUrl' || key === 'apiKey') {
        profiles[current][key] = value;
      }
    }
  }

  return profiles;
}

function serializeCredentials(profiles: Record<string, Profile>): string {
  return Object.entries(profiles)
    .map(([name, profile]) => `[${name}]\napiUrl = ${profile.apiUrl}\napiKey = ${profile.apiKey}\n`)
    .join('\n');
}

async function readAllProfiles(): Promise<Record<string, Profile>> {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { readFile } = await import('fs/promises');

  const path = credentialsPath(homedir(), join);
  try {
    const raw = await readFile(path, 'utf-8');
    return parseCredentials(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Resolve which profile to use: explicit name > AGNT_PROFILE env var > 'default'.
 */
export function resolveProfileName(explicit?: string): string {
  return explicit || process.env.AGNT_PROFILE || 'default';
}

/**
 * Load one profile's credentials. Throws a plain Error with a message
 * pointing at `agnt configure` when the file or the named profile is missing.
 */
export async function resolveProfile(explicitName?: string): Promise<Profile> {
  const name = resolveProfileName(explicitName);
  const profiles = await readAllProfiles();
  const profile = profiles[name];

  if (!profile || !profile.apiKey) {
    throw new Error(
      `No profile "${name}" found in ~/.agnt/credentials. Run: agnt configure --profile ${name} --api-url <url> --api-key <key>`
    );
  }

  return profile;
}

/**
 * Write (or overwrite) one named profile, creating ~/.agnt/credentials if absent.
 * chmod 600 after write — this file holds a live bearer token.
 */
export async function saveProfile(name: string, profile: Profile): Promise<void> {
  const { homedir } = await import('os');
  const { join, dirname } = await import('path');
  const { mkdir, writeFile, chmod } = await import('fs/promises');

  const path = credentialsPath(homedir(), join);
  await mkdir(dirname(path), { recursive: true });

  const profiles = await readAllProfiles();
  profiles[name] = profile;

  await writeFile(path, serializeCredentials(profiles), 'utf-8');
  await chmod(path, 0o600);
}

export async function listProfileNames(): Promise<string[]> {
  const profiles = await readAllProfiles();
  return Object.keys(profiles);
}

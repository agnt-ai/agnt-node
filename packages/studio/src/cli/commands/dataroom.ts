/**
 * agnt dataroom — manage the investor data room's access list from the
 * terminal: paste a dump of emails, give someone full access, take someone off.
 *
 * Every investor on the list has a level (agnt-backend G440):
 *   limited  the leave-behind: memo, deck, thesis, traction, GTM, product, team,
 *            the plan's summary pages. Diligence items are shown locked.
 *   full     everything, including the cap table, corporate documents, detailed
 *            financials and security PDFs.
 *
 * Auth is a data room key (drk_...), not an API key: AGNT staff create one in
 * agnt-console (Admin → Dataroom access → CLI keys). It manages this list and
 * nothing else. The CLI reads it from AGNT_DATAROOM_KEY, or from a
 * `dataroomKey = drk_...` line in the profile in ~/.agnt/credentials. It is sent
 * only in the X-Dataroom-Admin-Key header, to /dataroom-admin/* routes.
 *
 * Usage:
 *   agnt dataroom whoami
 *   agnt dataroom list [--access limited|full] [--email <e>] [--json]
 *   agnt dataroom add <emails...> [--file <path>] [--full] [--room-version <key>] [--notes <text>] [--json]
 *       (emails may be a pasted dump in any shape; `--file -` reads stdin)
 *   agnt dataroom set <email> [--full | --limited] [--room-version <key>|default]
 *   agnt dataroom remove <email>
 */

import { stripControl, safeJson } from './eval.js';
import { readProfile, resolveProfileName } from '../utils/credentials.js';

export const DEFAULT_API_URL = 'https://api.agnt.ai';
export const KEY_HEADER = 'X-Dataroom-Admin-Key';
export const KEY_ENV = 'AGNT_DATAROOM_KEY';

export type AccessLevel = 'limited' | 'full';

export interface DataroomOptions {
  profile?: string;
  apiUrl?: string;
  json?: boolean;
}

export interface Grant {
  id: string;
  email: string;
  domain: string | null;
  room: string;
  version: string | null;
  access: AccessLevel;
  grantedBy: string | null;
  notes: string | null;
  createdAt: string;
}

export interface BulkResult {
  added: string[];
  upgraded: string[];
  unchanged: string[];
  invalid: string[];
}

// ── input ────────────────────────────────────────────────────────────────

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const DOMAIN_ENTRY = /(?:^|[\s,;])(@[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=$|[\s,;])/gi;

/**
 * Every address in a pasted dump (a spreadsheet column, a To: line,
 * "Name <a@b.com>, ..."), lowercased, once each, in order. `@domain` entries
 * (a whole fund) are kept. The server checks each one again.
 */
export function extractEmails(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const v = value.toLowerCase().replace(/[.]+$/, '');
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const m of text.matchAll(DOMAIN_ENTRY)) add(m[1]);
  for (const m of text.matchAll(EMAIL)) add(m[0]);
  return out;
}

// ── the client ───────────────────────────────────────────────────────────

export interface DataroomClient {
  apiUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** The API URL and key: flags, then the environment, then the profile. */
export async function dataroomClient(opts: DataroomOptions = {}): Promise<DataroomClient> {
  const profile = await readProfile(resolveProfileName(opts.profile)).catch(() => null);
  const key = process.env[KEY_ENV]?.trim() || profile?.dataroomKey?.trim() || '';
  if (!key) {
    throw new Error(
      `No data room key. Set ${KEY_ENV}, or add "dataroomKey = drk_..." to your profile in ~/.agnt/credentials. ` +
        'AGNT staff create keys in agnt-console: Admin → Dataroom access → CLI keys.',
    );
  }
  const apiUrl = (opts.apiUrl || process.env.AGNT_API_URL || profile?.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
  assertSafeApiUrl(apiUrl);

  return {
    apiUrl,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', [KEY_HEADER]: key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data: any = await res.json().catch(() => null);
      if (res.status === 401) {
        throw new Error('The data room key was refused: it is wrong, expired or revoked. Create a new one in agnt-console.');
      }
      if (!res.ok) {
        throw new Error(`Data room API error (${res.status}): ${data?.error || data?.message || res.statusText}`);
      }
      return data as T;
    },
  };
}

/**
 * The key goes only over https, or plain http to this machine (a local API).
 * A typo or a hostile AGNT_API_URL must not send a drk_ key in clear text.
 */
export function assertSafeApiUrl(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`Not a valid API URL: ${apiUrl}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`Refusing to send the data room key to ${url.origin}: use https (plain http only for localhost).`);
  }
}

/** The one grant for this email (or `@domain`), or null. */
export async function findGrant(client: DataroomClient, email: string): Promise<Grant | null> {
  const value = email.trim().toLowerCase();
  const query = value.startsWith('@')
    ? `domain=${encodeURIComponent(value.slice(1))}`
    : `email=${encodeURIComponent(value)}`;
  const data = await client.request<{ entries?: Grant[] }>('GET', `/dataroom-admin/access?${query}`);
  return data.entries?.[0] ?? null;
}

// ── commands ─────────────────────────────────────────────────────────────

function fail(err: any): never {
  console.error(stripControl(err?.message ?? String(err)));
  process.exit(1);
}

const print = (line: string) => console.log(stripControl(line));

export async function runDataroomWhoami(opts: DataroomOptions = {}): Promise<void> {
  try {
    const client = await dataroomClient(opts);
    const me = await client.request<any>('GET', '/dataroom-admin/whoami');
    if (opts.json) return void console.log(safeJson(me));
    print(`Key ${me.prefix}… "${me.label}" for the ${me.room} room, created by ${me.createdBy}, expires ${String(me.expiresAt).slice(0, 10)}.`);
  } catch (err) {
    fail(err);
  }
}

export async function runDataroomList(opts: DataroomOptions & { access?: string; email?: string } = {}): Promise<void> {
  try {
    if (opts.access && opts.access !== 'limited' && opts.access !== 'full') throw new Error('--access is limited or full');
    const client = await dataroomClient(opts);
    const query = opts.email ? `?email=${encodeURIComponent(opts.email.trim().toLowerCase())}` : '';
    const data = await client.request<{ entries?: Grant[] }>('GET', `/dataroom-admin/access${query}`);
    const entries = (data.entries ?? []).filter((e) => !opts.access || e.access === opts.access);
    if (opts.json) return void console.log(safeJson(entries));
    if (entries.length === 0) return print('No one on the list matches.');
    const width = Math.max(...entries.map((e) => e.email.length), 5);
    for (const e of entries) {
      const parts = [e.email.padEnd(width), e.access.padEnd(7), e.version ?? 'default'];
      if (e.notes) parts.push(e.notes);
      print(parts.join('  '));
    }
    const full = entries.filter((e) => e.access === 'full').length;
    print(`\n${entries.length} on the list: ${full} full, ${entries.length - full} limited.`);
  } catch (err) {
    fail(err);
  }
}

export async function runDataroomAdd(
  args: string[],
  opts: DataroomOptions & { file?: string; full?: boolean; roomVersion?: string; notes?: string } = {},
): Promise<void> {
  try {
    let text = args.join('\n');
    if (opts.file) {
      const { readFile } = await import('fs/promises');
      text += '\n' + (opts.file === '-' ? await readStdin() : await readFile(opts.file, 'utf-8'));
    }
    const emails = extractEmails(text);
    if (emails.length === 0) throw new Error('No email addresses found. Pass them as arguments, or use --file <path> (--file - for stdin).');

    const client = await dataroomClient(opts);
    const access: AccessLevel = opts.full ? 'full' : 'limited';
    const result: BulkResult = { added: [], upgraded: [], unchanged: [], invalid: [] };
    // The server takes 500 per request.
    for (let i = 0; i < emails.length; i += 500) {
      const part = await client.request<BulkResult>('POST', '/dataroom-admin/access/bulk', {
        emails: emails.slice(i, i + 500),
        access,
        ...(opts.roomVersion && opts.roomVersion !== 'default' ? { version: opts.roomVersion } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
      });
      for (const k of ['added', 'upgraded', 'unchanged', 'invalid'] as const) result[k].push(...(part[k] ?? []));
    }

    if (opts.json) return void console.log(safeJson(result));
    print(`Added ${result.added.length} as ${access}.`);
    if (result.upgraded.length) print(`Raised to full: ${result.upgraded.length} (${result.upgraded.join(', ')}).`);
    if (result.unchanged.length) print(`Already on the list, unchanged: ${result.unchanged.length}${access === 'limited' ? ' (adding never lowers anyone)' : ''}.`);
    if (result.invalid.length) print(`Not valid, skipped: ${result.invalid.join(', ')}.`);
  } catch (err) {
    fail(err);
  }
}

export async function runDataroomSet(
  email: string,
  opts: DataroomOptions & { full?: boolean; limited?: boolean; roomVersion?: string } = {},
): Promise<void> {
  try {
    if (opts.full && opts.limited) throw new Error('Pass --full or --limited, not both.');
    const body: Record<string, unknown> = {};
    if (opts.full) body.access = 'full';
    if (opts.limited) body.access = 'limited';
    if (opts.roomVersion) body.version = opts.roomVersion === 'default' ? null : opts.roomVersion;
    if (Object.keys(body).length === 0) throw new Error('Nothing to change: pass --full, --limited or --room-version <key|default>.');

    const client = await dataroomClient(opts);
    const grant = await findGrant(client, email);
    if (!grant) throw new Error(`${email} is not on the list. Add them with: agnt dataroom add ${email}`);
    const data = await client.request<{ entry: Grant }>('PATCH', `/dataroom-admin/access/${grant.id}`, body);
    if (opts.json) return void console.log(safeJson(data.entry));
    print(`${data.entry.email}: ${data.entry.access}, version ${data.entry.version ?? 'default'}.`);
  } catch (err) {
    fail(err);
  }
}

export async function runDataroomRemove(email: string, opts: DataroomOptions = {}): Promise<void> {
  try {
    const client = await dataroomClient(opts);
    const grant = await findGrant(client, email);
    if (!grant) throw new Error(`${email} is not on the list.`);
    await client.request('DELETE', `/dataroom-admin/access/${grant.id}`);
    if (opts.json) return void console.log(safeJson({ removed: grant.email }));
    print(`Removed ${grant.email}. Their agent links stop working too.`);
  } catch (err) {
    fail(err);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

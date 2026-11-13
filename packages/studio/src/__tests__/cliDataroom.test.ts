/**
 * agnt dataroom — the investor data room's access list over /dataroom-admin/*.
 * fetch and the credentials profile are stubbed; the commands are the real ones.
 *
 * Pins: the key goes only in X-Dataroom-Admin-Key (never Authorization), a
 * pasted dump becomes one bulk request of clean addresses, `add` is limited
 * unless --full, `set` and `remove` find the grant by email or @domain first,
 * and a refused key says so.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const profile = { current: null as null | Record<string, string> };
vi.mock('../cli/utils/credentials.js', () => ({
  readProfile: async () => profile.current,
  resolveProfileName: (n?: string) => n || 'default',
}));

import {
  extractEmails,
  runDataroomAdd,
  runDataroomList,
  runDataroomRemove,
  runDataroomSet,
  runDataroomWhoami,
  KEY_ENV,
} from '../cli/commands/dataroom.js';

const KEY = `drk_${'k'.repeat(43)}`;
const ID = '64b0000000000000aaaaaaaa';

let fetchMock: ReturnType<typeof vi.fn>;
let out: string[];
let errs: string[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const calls = () =>
  fetchMock.mock.calls.map(([u, init]) => ({
    url: String(u),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    headers: (init as RequestInit | undefined)?.headers as Record<string, string>,
    body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
  }));

const GRANT = {
  id: ID, email: 'jane@fund.com', domain: null, room: 'investor', version: null,
  access: 'limited', grantedBy: 'staff@skej.com', notes: null, createdAt: '2026-11-13T00:00:00Z',
};

beforeEach(() => {
  profile.current = null;
  process.env[KEY_ENV] = KEY;
  delete process.env.AGNT_API_URL;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  out = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
});

afterEach(() => {
  delete process.env[KEY_ENV];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('extractEmails', () => {
  it('pulls clean addresses out of a messy paste', () => {
    const dump = 'Jane Doe <Jane@Fund.com>, bob@other.vc; "Ann" ann@x.io\njane@fund.com\nnope, also@bad\n@examplefund.com';
    expect(extractEmails(dump)).toEqual(['@examplefund.com', 'jane@fund.com', 'bob@other.vc', 'ann@x.io']);
  });
});

describe('agnt dataroom', () => {
  it('sends the key only in X-Dataroom-Admin-Key, to the default API', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, room: 'investor', label: 'laptop', prefix: 'drk_kkkkkk', createdBy: 's@skej.com', expiresAt: '2027-02-11T00:00:00Z' }));
    await runDataroomWhoami();
    const [c] = calls();
    expect(c.url).toBe('https://api.agnt.ai/dataroom-admin/whoami');
    expect(c.headers['X-Dataroom-Admin-Key']).toBe(KEY);
    expect(c.headers.Authorization).toBeUndefined();
    expect(out.join('\n')).toContain('investor room');
  });

  it('takes the key and API URL from the profile when the environment has none', async () => {
    delete process.env[KEY_ENV];
    profile.current = { apiUrl: 'https://staging-api.example/', apiKey: '', dataroomKey: KEY };
    fetchMock.mockResolvedValue(json({ ok: true, entries: [] }));
    await runDataroomList();
    expect(calls()[0].url).toBe('https://staging-api.example/dataroom-admin/access');
    expect(calls()[0].headers['X-Dataroom-Admin-Key']).toBe(KEY);
  });

  it('says how to get a key when there is none, and calls nothing', async () => {
    delete process.env[KEY_ENV];
    await expect(runDataroomList()).rejects.toThrow('exit 1');
    expect(errs.join('\n')).toContain('AGNT_DATAROOM_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('add sends one bulk request of clean addresses, limited by default', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, added: ['jane@fund.com', 'bob@other.vc'], upgraded: [], unchanged: ['ann@x.io'], invalid: [] }));
    await runDataroomAdd(['Jane <jane@fund.com>, bob@other.vc', 'ann@x.io'], { notes: 'demo day' });
    const [c] = calls();
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://api.agnt.ai/dataroom-admin/access/bulk');
    expect(c.body).toEqual({ emails: ['jane@fund.com', 'bob@other.vc', 'ann@x.io'], access: 'limited', notes: 'demo day' });
    expect(out.join('\n')).toContain('Added 2 as limited');
    expect(out.join('\n')).toContain('never lowers anyone');
  });

  it('add --full --room-version 30m asks for both', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, added: [], upgraded: ['jane@fund.com'], unchanged: [], invalid: [] }));
    await runDataroomAdd(['jane@fund.com'], { full: true, roomVersion: '30m' });
    expect(calls()[0].body).toEqual({ emails: ['jane@fund.com'], access: 'full', version: '30m' });
    expect(out.join('\n')).toContain('Raised to full: 1');
  });

  it('add with nothing that looks like an email calls nothing', async () => {
    await expect(runDataroomAdd(['no emails here'])).rejects.toThrow('exit 1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('set finds the grant by email, then patches only what was asked', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, entries: [GRANT] }))
      .mockResolvedValueOnce(json({ ok: true, entry: { ...GRANT, access: 'full' } }));
    await runDataroomSet('Jane@Fund.com', { full: true });
    const [find, patch] = calls();
    expect(find.url).toBe('https://api.agnt.ai/dataroom-admin/access?email=jane%40fund.com');
    expect(patch.method).toBe('PATCH');
    expect(patch.url).toBe(`https://api.agnt.ai/dataroom-admin/access/${ID}`);
    expect(patch.body).toEqual({ access: 'full' });
  });

  it('set and remove look a @domain up by domain', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, entries: [{ ...GRANT, email: '@fund.com', domain: 'fund.com' }] }))
      .mockResolvedValueOnce(json({ ok: true }));
    await runDataroomRemove('@fund.com');
    expect(calls()[0].url).toBe('https://api.agnt.ai/dataroom-admin/access?domain=fund.com');
    expect(calls()[1].method).toBe('DELETE');
  });

  it('set refuses --full with --limited, or nothing to change', async () => {
    await expect(runDataroomSet('a@b.com', { full: true, limited: true })).rejects.toThrow('exit 1');
    await expect(runDataroomSet('a@b.com', {})).rejects.toThrow('exit 1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remove of someone not on the list changes nothing', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, entries: [] }));
    await expect(runDataroomRemove('x@y.com')).rejects.toThrow('exit 1');
    expect(calls()).toHaveLength(1);
  });

  it('never sends the key over plain http, except to this machine', async () => {
    process.env.AGNT_API_URL = 'http://api.agnt.ai';
    await expect(runDataroomList()).rejects.toThrow('exit 1');
    expect(errs.join('\n')).toContain('use https');
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.AGNT_API_URL = 'http://127.0.0.1:4000';
    fetchMock.mockResolvedValue(json({ ok: true, entries: [] }));
    await runDataroomList();
    expect(calls()[0].url).toBe('http://127.0.0.1:4000/dataroom-admin/access');
  });

  it('a refused key says it is wrong, expired or revoked', async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: 'Unauthorized' }, 401));
    await expect(runDataroomList()).rejects.toThrow('exit 1');
    expect(errs.join('\n')).toContain('wrong, expired or revoked');
  });

  it('list filters by level and counts', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, entries: [GRANT, { ...GRANT, id: 'x', email: 'vip@fund.com', access: 'full' }] }));
    await runDataroomList({ access: 'full' });
    const text = out.join('\n');
    expect(text).toContain('vip@fund.com');
    expect(text).not.toContain('jane@fund.com');
    expect(text).toContain('1 on the list: 1 full, 0 limited');
  });
});

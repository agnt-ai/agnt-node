/**
 * agnt skill — CRUD over /skills. fetch and the credentials profile are
 * stubbed; the commands and API client are the real ones.
 *
 * Pins: update never creates a copy on --name (rename refused), update sends
 * the FULL exported manifest (so v1 / dev / live deployments aren't left with a
 * partial manifest), export -o refuses to overwrite without --force, plus
 * name slugging, id-vs-name resolution and push status stamping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../cli/utils/credentials.js', () => ({
  resolveProfile: async () => ({ apiUrl: 'https://api.test', apiKey: 'ak_live_test' }),
}));

import {
  runSkillList, runSkillGet, runSkillCreate, runSkillUpdate, runSkillPush, runSkillExport,
} from '../cli/commands/skill.js';

const ID = '64b0000000000000aaaaaaaa';
const ID2 = '64b0000000000000bbbbbbbb';

const FULL = {
  $manifestVersion: 1, name: 'my-skill', title: 'Old title', kind: 'knowledge', status: 'active',
  access: 'private', description: 'Keep me', whenToUse: 'When asked', instructions: 'Old body',
};

let fetchMock: ReturnType<typeof vi.fn>;
let out: string[];
let err: string[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const calls = () => fetchMock.mock.calls.map(([u, init]) => ({
  method: (init as RequestInit | undefined)?.method ?? 'GET',
  path: String(u).replace('https://api.test', ''),
  body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
}));
const imports = () => calls().filter(c => c.path === '/skills/import');

/** Route-based fetch stub: ID resolves to `my-skill`. */
function route(over: { list?: any[]; importResult?: any } = {}) {
  fetchMock.mockImplementation(async (url: any, init?: RequestInit) => {
    const path = String(url).replace('https://api.test', '');
    const method = init?.method ?? 'GET';
    if (path === '/skills/import') return json({ ok: true, action: 'updated', skill: { id: ID, name: 'my-skill', status: 'active', kind: 'knowledge' }, ...over.importResult });
    if (path.startsWith('/skills?')) return json({ ok: true, skills: over.list ?? [{ id: ID, name: 'my-skill' }] });
    if (path === `/skills/${ID}/export`) return json(FULL);
    if (path === `/skills/${ID}` && method === 'GET') return json({ ok: true, skill: { id: ID, name: 'my-skill', kind: 'knowledge', status: 'active', title: 'Old title' } });
    return json({ error: `unexpected ${method} ${path}` }, 500);
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// process.exit is stubbed to throw; a refusal surfaces as a thrown "exit 1".
const refused = async (p: Promise<void>) => { await expect(p).rejects.toThrow('exit 1'); };

describe('agnt skill update', () => {
  it('refuses --name that differs from the current name, and never writes', async () => {
    route();
    await refused(runSkillUpdate(ID, { name: 'other-name', title: 'X' }));
    expect(err.join('\n')).toMatch(/Renaming isn't supported/);
    expect(imports()).toHaveLength(0);
  });

  it('accepts --name equal to the current name as a no-op and targets the existing skill', async () => {
    route();
    await runSkillUpdate('my-skill', { name: 'my-skill', title: 'New title' });
    const [imp] = imports();
    expect(imp.body.manifest.name).toBe('my-skill');
    expect(imp.body.manifest.title).toBe('New title');
  });

  it('sends the full exported manifest with only the changed field applied', async () => {
    route();
    await runSkillUpdate(ID, { title: 'New title' });
    const [imp] = imports();
    expect(imp.body.options.conflictStrategy).toBe('overwrite');
    expect(imp.body.manifest).toEqual({ ...FULL, title: 'New title' });
    expect(imp.body.manifest.instructions).toBe('Old body');
    expect(imp.body.manifest.description).toBe('Keep me');
  });

  it('lets --status through (overwrite, not merge) on top of the full manifest', async () => {
    route();
    await runSkillUpdate(ID, { status: 'archived' });
    expect(imports()[0].body.manifest).toMatchObject({ status: 'archived', instructions: 'Old body' });
  });

  it('errors when nothing is being changed', async () => {
    route();
    await refused(runSkillUpdate(ID, {}));
    expect(imports()).toHaveLength(0);
  });

  it('errors when --name is the only flag and matches the current name', async () => {
    route();
    await refused(runSkillUpdate(ID, { name: 'my-skill' }));
    expect(imports()).toHaveLength(0);
  });

  it('resolves a name through the list search (exact match) and then fetches by id', async () => {
    route({ list: [{ id: ID2, name: 'my-skill-2' }, { id: ID, name: 'my-skill' }] });
    await runSkillUpdate('my-skill', { title: 'T' });
    expect(calls().some(c => c.path === `/skills/${ID}/export`)).toBe(true);
    expect(calls().some(c => c.path === `/skills/${ID2}`)).toBe(false);
  });
});

describe('agnt skill get / resolve', () => {
  it('goes straight to GET by id for an ObjectId', async () => {
    route();
    await runSkillGet(ID, {});
    expect(calls().map(c => c.path)).toEqual([`/skills/${ID}`]);
  });

  it('errors when no skill has that exact name', async () => {
    route({ list: [{ id: ID2, name: 'my-skill-2' }] });
    await refused(runSkillGet('my-skill', {}));
    expect(err.join('\n')).toMatch(/not found/);
  });

  it('warns on duplicate names but still resolves', async () => {
    route({ list: [{ id: ID, name: 'my-skill' }, { id: ID2, name: 'my-skill' }] });
    await runSkillGet('my-skill', {});
    expect(err.join('\n')).toMatch(/2 skills named 'my-skill'/);
  });
});

describe('agnt skill create', () => {
  it('derives a valid slug from the title, defaults to active knowledge, and uses skip', async () => {
    route({ importResult: { action: 'created' } });
    await runSkillCreate({ title: '  My Great Skill!  ' });
    const [imp] = imports();
    expect(imp.body.manifest).toMatchObject({ name: 'my-great-skill', kind: 'knowledge', status: 'active' });
    expect(imp.body.options.conflictStrategy).toBe('skip');
  });

  it('--draft opts out of active', async () => {
    route({ importResult: { action: 'created' } });
    await runSkillCreate({ title: 'X', draft: true });
    expect(imports()[0].body.manifest.status).toBe('draft');
  });

  it('fails when the name already exists', async () => {
    route({ importResult: { action: 'skipped' } });
    await refused(runSkillCreate({ title: 'X' }));
  });
});

describe('agnt skill push', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skill-push-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('unwraps an `agnt pull` file and stamps status active on a flat manifest without one', async () => {
    route();
    const f = join(dir, 'm.json');
    await writeFile(f, JSON.stringify({ manifest: { name: 'a', kind: 'knowledge' }, pulledAt: 'x' }));
    await runSkillPush(f, {});
    expect(imports()[0].body.manifest).toEqual({ name: 'a', kind: 'knowledge', status: 'active' });
    expect(imports()[0].body.options.conflictStrategy).toBe('overwrite');
  });

  it('stamps under metadata when the manifest has one, and leaves an existing status alone', async () => {
    route();
    const f = join(dir, 'm.json');
    await writeFile(f, JSON.stringify({ metadata: { name: 'a' }, spec: { kind: 'knowledge' } }));
    await runSkillPush(f, {});
    expect(imports()[0].body.manifest.metadata.status).toBe('active');

    fetchMock.mockClear();
    await writeFile(f, JSON.stringify({ name: 'a', kind: 'knowledge', status: 'draft' }));
    await runSkillPush(f, {});
    expect(imports()[0].body.manifest.status).toBe('draft');
  });

  it('--draft does not stamp a status; bad --conflict and non-object files are refused', async () => {
    route();
    const f = join(dir, 'm.json');
    await writeFile(f, JSON.stringify({ name: 'a', kind: 'knowledge' }));
    await runSkillPush(f, { draft: true });
    expect(imports()[0].body.manifest.status).toBeUndefined();

    await refused(runSkillPush(f, { conflict: 'nuke' }));
    await writeFile(f, '[1]');
    await refused(runSkillPush(f, {}));
  });
});

describe('agnt skill export -o', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skill-export-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('writes a new file', async () => {
    route();
    const f = join(dir, 'out.json');
    await runSkillExport(ID, { output: f });
    expect(JSON.parse(await readFile(f, 'utf-8'))).toEqual(FULL);
  });

  it('refuses to overwrite an existing file without --force, leaving it untouched', async () => {
    route();
    const f = join(dir, 'out.json');
    await writeFile(f, 'precious');
    await refused(runSkillExport(ID, { output: f }));
    expect(err.join('\n')).toMatch(/already exists — pass --force/);
    expect(await readFile(f, 'utf-8')).toBe('precious');
  });

  it('overwrites with --force', async () => {
    route();
    const f = join(dir, 'out.json');
    await writeFile(f, 'old');
    await runSkillExport(ID, { output: f, force: true });
    expect(JSON.parse(await readFile(f, 'utf-8'))).toEqual(FULL);
  });
});

describe('agnt skill list', () => {
  it('rejects a non-positive-integer --limit/--page before any request', async () => {
    route();
    await refused(runSkillList({ limit: 'abc' }));
    await refused(runSkillList({ page: '0' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips terminal control characters from error output', async () => {
    fetchMock.mockResolvedValue(new Response('bad\u001b[31mred', { status: 500 }));
    await refused(runSkillList({}));
    expect(err.join('')).not.toContain('\u001b');
  });
});

/**
 * agnt workflow — push/pull/list over /skills. fetch and the credentials
 * profile are stubbed; the commands and API client are the real ones.
 *
 * Pins: push goes through POST /skills / PATCH /skills/:id and NEVER
 * /skills/import (which skips trigger stamping + scheduling), push refuses to
 * clobber without --update, server-managed fields (origin/tier/id/...) are
 * never sent, and pull output round-trips through push.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../cli/utils/credentials.js', () => ({
  resolveProfile: async () => ({ apiUrl: 'https://api.test', apiKey: 'ak_live_test' }),
}));

import { runWorkflowPush, runWorkflowPull, runWorkflowList, validateDefinition } from '../cli/commands/workflow.js';

const ID = '64b0000000000000aaaaaaaa';

const DEF = {
  name: 'daily-digest', title: 'Daily digest', description: 'Digest', scheduleType: 'trigger-based',
  workflowStatus: 'active', hidden: false, triggers: [{ on: 'cron', schedule: '0 9 * * *' }],
};

let fetchMock: ReturnType<typeof vi.fn>;
let out: string[];
let err: string[];
let dir: string;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const calls = () => fetchMock.mock.calls.map(([u, init]) => ({
  method: (init as RequestInit | undefined)?.method ?? 'GET',
  path: String(u).replace('https://api.test', ''),
  body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
}));
const writes = () => calls().filter(c => c.method !== 'GET');

function route(over: { list?: any[]; createStatus?: number; patchStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: any, init?: RequestInit) => {
    const path = String(url).replace('https://api.test', '');
    const method = init?.method ?? 'GET';
    if (path.startsWith('/skills?')) return json({ ok: true, skills: over.list ?? [], total: (over.list ?? []).length });
    if (path === '/skills' && method === 'POST') {
      if (over.createStatus) return new Response('{"error":"Skill exists"}', { status: over.createStatus });
      return json({ ok: true, skill: { id: ID, name: 'daily-digest', kind: 'workflow', workflowStatus: 'active' } }, 201);
    }
    if (path === `/skills/${ID}` && method === 'PATCH' && over.patchStatus) return json({ ok: false, error_code: 'forbidden', message: 'You can only edit skills you own' }, over.patchStatus);
    if (path === `/skills/${ID}` && method === 'PATCH') return json({ ok: true, skill: { id: ID, name: 'daily-digest', kind: 'workflow', workflowStatus: 'active' } });
    if (path === `/skills/${ID}` && method === 'GET') {
      return json({ ok: true, skill: { ...DEF, id: ID, _id: ID, kind: 'workflow', origin: 'portal', tier: 'community', account: 'a1', createdAt: 'x', runCount: 3, followers: ['a@b.c'], billedTo: 'u1', triggerSources: [{ id: 't' }] } });
    }
    return json({ error: `unexpected ${method} ${path}` }, 500);
  });
}

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  out = []; err = [];
  dir = await mkdtemp(join(tmpdir(), 'agnt-wf-'));
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const refused = async (p: Promise<void>) => { await expect(p).rejects.toThrow('exit 1'); };
const file = async (obj: unknown, name = 'wf.json') => {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(obj));
  return p;
};

describe('validateDefinition', () => {
  it('defaults kind to workflow and strips server-managed fields', () => {
    const d = validateDefinition({ ...DEF, id: 'x', origin: 'studio', tier: 'agnt', createdBy: 'a@b.c' });
    expect(d.kind).toBe('workflow');
    for (const f of ['id', 'origin', 'tier', 'createdBy']) expect(d).not.toHaveProperty(f);
  });
  it('accepts a { skill } wrapper', () => {
    expect(validateDefinition({ skill: DEF }).name).toBe('daily-digest');
  });
  it.each([
    [{ ...DEF, kind: 'knowledge' }, /kind must be 'workflow'/],
    [{ ...DEF, name: 'Bad Name' }, /name is required/],
    [{ ...DEF, title: '' }, /title is required/],
    [{ ...DEF, description: undefined }, /description is required/],
    [{ ...DEF, triggers: 'nope' }, /triggers must be an array/],
    [{ ...DEF, scheduleType: 'weekly' }, /scheduleType must be one of/],
    [[1, 2], /JSON object/],
  ])('rejects invalid definition %#', (input, msg) => {
    expect(() => validateDefinition(input)).toThrow(msg);
  });
});

describe('agnt workflow push', () => {
  it('creates via POST /skills (never /skills/import) with kind workflow', async () => {
    route();
    await runWorkflowPush(await file(DEF), {});
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].method).toBe('POST');
    expect(w[0].path).toBe('/skills');
    expect(w[0].body).toMatchObject({ ...DEF, kind: 'workflow' });
    expect(calls().some(c => c.path.includes('/import'))).toBe(false);
    expect(out.join('\n')).toMatch(/Workflow created: daily-digest/);
  });

  it('refuses to overwrite an existing workflow without --update, and never writes', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }] });
    await refused(runWorkflowPush(await file(DEF), {}));
    expect(err.join('\n')).toMatch(/already exists — pass --update/);
    expect(writes()).toHaveLength(0);
  });

  it('--update PATCHes the existing id without name/kind/server fields', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }] });
    await runWorkflowPush(await file({ ...DEF, origin: 'studio', tier: 'agnt' }), { update: true });
    const [w] = writes();
    expect(w.method).toBe('PATCH');
    expect(w.path).toBe(`/skills/${ID}`);
    for (const f of ['name', 'kind', 'origin', 'tier']) expect(w.body).not.toHaveProperty(f);
    expect(w.body.triggers).toEqual(DEF.triggers);
    expect(out.join('\n')).toMatch(/Workflow updated/);
  });

  it('--update 403 prints a hint pointing at the known limit', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }], patchStatus: 403 });
    await refused(runWorkflowPush(await file(DEF), { update: true }));
    expect(err.join('\n')).toMatch(/\(403\)[\s\S]*Hint:.*README/);
  });

  it('does not match a different skill whose name merely contains the slug', async () => {
    route({ list: [{ id: 'other', name: 'daily-digest-2', kind: 'workflow' }] });
    await runWorkflowPush(await file(DEF), {});
    expect(writes()[0].method).toBe('POST');
  });

  it('refuses to --update a same-named non-workflow skill', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'knowledge' }] });
    await refused(runWorkflowPush(await file(DEF), { update: true }));
    expect(err.join('\n')).toMatch(/not a workflow/);
    expect(writes()).toHaveLength(0);
  });

  it('explains a 409 from a name the key cannot see', async () => {
    route({ createStatus: 409 });
    await refused(runWorkflowPush(await file(DEF), {}));
    expect(err.join('\n')).toMatch(/not visible to this key/);
  });

  it('rejects bad JSON without any network call', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, '{nope');
    await refused(runWorkflowPush(p, {}));
    expect(err.join('\n')).toMatch(/Could not read/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('--json prints action and skill', async () => {
    route();
    await runWorkflowPush(await file(DEF), { json: true });
    expect(JSON.parse(out.join(''))).toMatchObject({ action: 'created', skill: { id: ID } });
  });
});

describe('agnt workflow push: what the API would reject or silently change', () => {
  // Shape of a real pull: serialize() emits null for unset optional fields.
  const PULLED = {
    ...DEF, whenToUse: null, instructions: null, mcpSource: null, mcpAuthServerUrl: null, mcpTransport: null,
    category: null, companionSkill: null, modelTier: null, maxRuns: null, followers: [], processingBufferMs: 300000,
    silentOnNoOp: false, status: 'active', skillCollection: null,
  };

  it('create omits nulls that POST /skills rejects but keeps meaningful nulls, and drops server-ignored defaults quietly', async () => {
    route();
    await runWorkflowPush(await file(PULLED), {});
    const body = writes()[0].body;
    for (const f of ['whenToUse', 'instructions', 'mcpSource', 'mcpAuthServerUrl', 'mcpTransport', 'category', 'companionSkill',
      'status', 'followers', 'processingBufferMs', 'silentOnNoOp', 'skillCollection']) expect(body).not.toHaveProperty(f);
    expect(body.modelTier).toBeNull();
    expect(body.maxRuns).toBeNull();
    expect(err.join('\n')).not.toMatch(/Warning/);
  });

  it('update omits the always-rejected nulls but keeps PATCH-nullable ones (so null can still clear)', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }] });
    await runWorkflowPush(await file(PULLED), { update: true });
    const body = writes()[0].body;
    for (const f of ['whenToUse', 'instructions', 'mcpAuthServerUrl']) expect(body).not.toHaveProperty(f);
    expect(body.category).toBeNull();
  });

  it('sends a non-active workflowStatus on create (staging honours it)', async () => {
    route();
    await runWorkflowPush(await file({ ...DEF, workflowStatus: 'paused' }), {});
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.workflowStatus).toBe('paused');
  });

  it('warns when a non-default field the create API ignores is set', async () => {
    route();
    await runWorkflowPush(await file({ ...DEF, silentOnNoOp: true }), {});
    expect(err.join('\n')).toMatch(/'silentOnNoOp' is ignored/);
    expect(writes()[0].body).not.toHaveProperty('silentOnNoOp');
  });

  it('never sends followers/billedTo/triggerSources from a file', async () => {
    route();
    await runWorkflowPush(await file({ ...DEF, followers: ['a@b.co'], billedTo: 'u1', triggerSources: [{ id: 't' }] }), {});
    for (const f of ['followers', 'billedTo', 'triggerSources']) expect(writes()[0].body).not.toHaveProperty(f);
  });

  it('accepts a file with a UTF-8 BOM', async () => {
    route();
    const p = join(dir, 'bom.json');
    await writeFile(p, '\uFEFF' + JSON.stringify(DEF));
    await runWorkflowPush(p, {});
    expect(writes()[0].method).toBe('POST');
  });

  it('finds an exact-name match that is not on the first page of the substring search', async () => {
    const filler = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, name: `daily-digest-${i}`, kind: 'workflow' }));
    fetchMock.mockImplementation(async (url: any, init?: RequestInit) => {
      const path = String(url).replace('https://api.test', '');
      if (path.startsWith('/skills?')) {
        const page = Number(new URL('https://x' + path).searchParams.get('page') ?? 1);
        return json({ ok: true, total: 201, skills: page === 1 ? filler : [{ id: ID, name: 'daily-digest', kind: 'workflow' }] });
      }
      return json({ error: `unexpected ${init?.method} ${path}` }, 500);
    });
    await refused(runWorkflowPush(await file(DEF), {}));
    expect(err.join('\n')).toMatch(/already exists — pass --update/);
  });
});

describe('agnt workflow pull', () => {
  it('does not warn about duplicate skills when the list repeats one row per install', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }, { id: ID, name: 'daily-digest', kind: 'workflow' }] });
    await runWorkflowPull('daily-digest', {});
    expect(err.join('\n')).not.toMatch(/Warning/);
  });

  it('resolves by name, strips server fields, and prints the definition', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }] });
    await runWorkflowPull('daily-digest', {});
    const def = JSON.parse(out.join(''));
    expect(def).toMatchObject(DEF);
    for (const f of ['id', '_id', 'origin', 'tier', 'account', 'createdAt', 'runCount', 'followers', 'billedTo', 'triggerSources']) expect(def).not.toHaveProperty(f);
  });

  it('refuses a non-workflow skill', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, skill: { id: ID, name: 'k', kind: 'knowledge' } }));
    await refused(runWorkflowPull(ID, {}));
    expect(err.join('\n')).toMatch(/not a workflow/);
  });

  it('-o writes a file that round-trips through push --update, and refuses to clobber without --force', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', kind: 'workflow' }] });
    const p = join(dir, 'out.json');
    await runWorkflowPull('daily-digest', { output: p });
    expect(JSON.parse(await readFile(p, 'utf-8'))).toMatchObject(DEF);

    await refused(runWorkflowPull('daily-digest', { output: p }));
    expect(err.join('\n')).toMatch(/already exists — pass --force/);
    await runWorkflowPull('daily-digest', { output: p, force: true });

    await runWorkflowPush(p, { update: true });
    expect(writes()[0].method).toBe('PATCH');
  });
});

describe('agnt workflow list', () => {
  it('queries kind=workflow and prints status, schedule type and trigger count', async () => {
    route({ list: [{ id: ID, name: 'daily-digest', title: 'Daily digest', workflowStatus: 'active', scheduleType: 'trigger-based', triggers: [{}, {}] }] });
    await runWorkflowList({ limit: '10' });
    expect(calls()[0].path).toBe('/skills?kind=workflow&limit=10');
    expect(out.join('\n')).toMatch(/\[active\/trigger-based\]\s+daily-digest\s+Daily digest\s+2 trigger\(s\)/);
  });

  it('--json prints the raw list and rejects a bad --limit', async () => {
    route({ list: [{ id: ID, name: 'w' }] });
    await runWorkflowList({ json: true });
    expect(JSON.parse(out.join('')).workflows).toHaveLength(1);
    await refused(runWorkflowList({ limit: '0' }));
  });
});

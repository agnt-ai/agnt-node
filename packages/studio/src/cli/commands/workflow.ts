/**
 * agnt workflow — push, pull and list workflow skills (kind 'workflow') from
 * the terminal, so a workflow definition can live in git as a JSON file.
 *
 * Deliberately NOT built on POST /skills/import (`agnt skill push`): that
 * route does a raw Skill.create and skips everything the console does for a
 * workflow — trigger id stamping, triggers.category stamping, interval-anchor
 * stamping and ticker scheduling. This goes through the same two routes the
 * console uses instead:
 *   - POST /skills        (skillsController.create) for a new workflow
 *   - PATCH /skills/:id   (skillsController.update) for --update
 * both of which stamp trigger anchors and call scheduleWorkflow.
 *
 * A definition file is a JSON object describing the Skill, e.g.
 *   { "name": "daily-digest", "title": "Daily digest", "description": "...",
 *     "scheduleType": "trigger-based", "workflowStatus": "active",
 *     "hidden": false, "triggers": [ { "on": "cron", "schedule": "0 9 * * *" } ] }
 * `kind` defaults to 'workflow' when omitted. `agnt workflow pull` writes the
 * same shape (server-managed fields removed), so pull -> edit -> push
 * --update round-trips.
 *
 * Usage:
 *   agnt workflow push <file.json> [--update] [--profile <name>] [--json]
 *   agnt workflow pull <name> [-o <file>] [--force] [--profile <name>]
 *   agnt workflow list [--limit n] [--page n] [--profile <name>] [--json]
 */

import { clientFor } from './run.js';
import { stripControl, safeJson } from './eval.js';
import { resolveSkill } from './skill.js';
import type { AgntApiClient, SkillSummary } from '../utils/api.js';

export interface WorkflowProfileOptions {
  profile?: string;
  json?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCHEDULE_TYPES = ['now', 'recurring', 'trigger-based'];

// Server-managed / identity fields that a pulled definition carries but that
// must never be sent back: they are either ignored by the schema or, worse
// (origin, tier, createdBy), change how the server authorizes the write.
const SERVER_MANAGED_FIELDS = [
  'id', '_id', 'account', 'ownerSlug', 'installation', 'createdAt', 'updatedAt',
  'runCount', 'lastRunAt', 'exhaustedReason', 'enrichmentStatus',
  'origin', 'tier', 'createdBy', 'version', 'versions', '__v',
];

// Fields the server's serializer emits as `null` (or that the schema otherwise
// cannot take as null) but whose request schema is `z.string()...optional()`
// with no `.nullable()`: sending the null back is a 400 ("whenToUse: Invalid
// input"), so a pulled file would not push. Omitting them means "unset".
const NULL_REJECTED_ALWAYS = [
  'whenToUse', 'instructions', 'mcpSource', 'mcpServerUrl', 'mcpAuthServerUrl', 'mcpTransport', 'pricing', 'folder',
];
// Nullable on PATCH (null clears them) but not accepted as null by POST.
const NULL_REJECTED_ON_CREATE = ['category', 'secondaryCategory', 'setupDifficulty', 'capabilities', 'companionSkill'];

// CreateSkillBodySchema does not declare these, so POST /skills silently strips
// them (PATCH accepts them). Value = the server default; a file that differs
// from it gets a warning instead of a silent no-op.
const CREATE_IGNORED_DEFAULTS: Record<string, (v: any) => boolean> = {
  status: v => v === 'active',
  followers: v => Array.isArray(v) && v.length === 0,
  silentOnNoOp: v => v === false,
  processingBufferMs: v => v === 300000,
  skillCollection: v => v === null,
};

/** Body for POST /skills / PATCH /skills/:id: drop nulls the schema rejects. */
export function prepareBody(def: Record<string, any>, mode: 'create' | 'update'): Record<string, any> {
  const out: Record<string, any> = { ...def };
  const drop = mode === 'create' ? [...NULL_REJECTED_ALWAYS, ...NULL_REJECTED_ON_CREATE] : NULL_REJECTED_ALWAYS;
  for (const f of drop) if (out[f] === null) delete out[f];
  return out;
}

function fail(err: any): never {
  console.error(stripControl(err?.message ?? String(err)));
  process.exit(1);
}

/** Drop server-managed fields, returning a copy safe to push or save. */
export function sanitizeDefinition(skill: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...skill };
  for (const f of SERVER_MANAGED_FIELDS) delete out[f];
  return out;
}

/** Parse + validate a definition file's parsed JSON. Throws a readable Error. */
export function validateDefinition(parsed: unknown): Record<string, any> {
  // Accept a bare definition or a `{ skill: {...} }` wrapper.
  const raw: any = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as any).skill
    && typeof (parsed as any).skill === 'object'
    ? (parsed as any).skill
    : parsed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Workflow file must contain a JSON object');
  }
  const def = sanitizeDefinition(raw);
  if (def.kind !== undefined && def.kind !== 'workflow') {
    throw new Error(`kind must be 'workflow' (got '${def.kind}') — use \`agnt skill push\` for other kinds`);
  }
  def.kind = 'workflow';
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) {
    throw new Error('name is required and must be a slug (lowercase letters, digits and dashes, e.g. "daily-digest")');
  }
  if (typeof def.title !== 'string' || !def.title.trim()) throw new Error('title is required');
  if (typeof def.description !== 'string' || !def.description.trim()) throw new Error('description is required');
  if (def.triggers !== undefined && !Array.isArray(def.triggers)) throw new Error('triggers must be an array');
  if (def.scheduleType !== undefined && !SCHEDULE_TYPES.includes(def.scheduleType)) {
    throw new Error(`scheduleType must be one of ${SCHEDULE_TYPES.join(', ')} (got '${def.scheduleType}')`);
  }
  return def;
}

async function findByName(client: AgntApiClient, name: string): Promise<SkillSummary | null> {
  // `q` substring-matches; ask for the max page so an exact match isn't pushed
  // off the first page by similarly named skills (same approach as resolveSkill).
  // Page on: `q` also matches descriptions and file content, and the list is
  // newest-first, so the exact match can sit beyond page 1.
  const limit = 200;
  for (let page = 1; page <= 10; page++) {
    const { skills, total } = await client.listSkills({ q: name, limit, page });
    const hit = skills.find(s => s.name === name);
    if (hit) return hit;
    if (skills.length < limit || (total !== undefined && page * limit >= total)) break;
  }
  return null;
}

function positiveInt(flag: string, v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got "${v}")`);
  return n;
}

// ── push ─────────────────────────────────────────────────────────────────────

export interface WorkflowPushOptions extends WorkflowProfileOptions {
  update?: boolean;
}

export async function runWorkflowPush(file: string, opts: WorkflowPushOptions): Promise<void> {
  try {
    const { readFile } = await import('fs/promises');
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
    } catch (e: any) {
      throw new Error(`Could not read ${file} as JSON: ${e.message}`);
    }
    const def = validateDefinition(parsed);

    const client = await clientFor(opts.profile);
    const existing = await findByName(client, def.name);

    let action: 'created' | 'updated';
    let skill: SkillSummary;
    if (existing) {
      if (!opts.update) {
        throw new Error(`Workflow '${def.name}' already exists — pass --update to overwrite it`);
      }
      if (existing.kind && existing.kind !== 'workflow') {
        throw new Error(`'${def.name}' exists but is a '${existing.kind}' skill, not a workflow — refusing to overwrite it`);
      }
      const id = existing.id ?? existing._id;
      if (!id) throw new Error(`Could not resolve an id for '${def.name}'`);
      // Renaming is not supported, and kind must not change on update.
      const { name: _name, kind: _kind, ...patch } = prepareBody(def, 'update');
      skill = await client.updateSkill(id, patch);
      action = 'updated';
    } else {
      // workflowStatus is sent on create: verified on staging (2026-09-29) that
      // 'paused' is honoured (the workflow comes back 'disabled' and unscheduled).
      const body = prepareBody(def, 'create');
      for (const [f, isDefault] of Object.entries(CREATE_IGNORED_DEFAULTS)) {
        if (f in body && !isDefault(body[f])) console.error(`Warning: '${f}' is ignored by the create API and was not applied.`);
        delete body[f];
      }
      try {
        skill = await client.createSkill(body);
      } catch (e: any) {
        // A user-scoped key never lists hidden/draft skills, so a name can
        // exist without findByName seeing it — surface that instead of a bare 409.
        if (/\(409\)/.test(e?.message ?? '')) {
          throw new Error(`Workflow '${def.name}' already exists but is not visible to this key (hidden or draft?). ${e.message}`);
        }
        throw e;
      }
      action = 'created';
    }

    if (opts.json) {
      console.log(safeJson({ action, skill }));
      return;
    }
    const id = stripControl(String(skill?.id ?? skill?._id ?? '?'));
    console.log(`Workflow ${action}: ${stripControl(skill?.name ?? def.name)} (${id}) [${stripControl(String(skill?.workflowStatus ?? 'no status'))}]`);
  } catch (err: any) {
    fail(err);
  }
}

// ── pull ─────────────────────────────────────────────────────────────────────

export interface WorkflowPullOptions extends WorkflowProfileOptions {
  output?: string;
  force?: boolean;
}

export async function runWorkflowPull(name: string, opts: WorkflowPullOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const skill = await resolveSkill(client, name);
    if (skill.kind && skill.kind !== 'workflow') {
      throw new Error(`'${name}' is a '${skill.kind}' skill, not a workflow`);
    }
    const def = sanitizeDefinition(skill);

    if (opts.output) {
      const { writeFile } = await import('fs/promises');
      try {
        await writeFile(opts.output, JSON.stringify(def, null, 2) + '\n', { encoding: 'utf-8', flag: opts.force ? 'w' : 'wx' });
      } catch (e: any) {
        if (e?.code === 'EEXIST') throw new Error(`${opts.output} already exists — pass --force to overwrite it`);
        throw e;
      }
      console.error(`Pulled ${name} → ${opts.output}`);
    } else {
      // safeJson escapes rather than deletes, so piping to a file still round-trips.
      console.log(safeJson(def));
    }
  } catch (err: any) {
    fail(err);
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface WorkflowListOptions extends WorkflowProfileOptions {
  limit?: string;
  page?: string;
}

export async function runWorkflowList(opts: WorkflowListOptions): Promise<void> {
  try {
    const limit = positiveInt('--limit', opts.limit);
    const page = positiveInt('--page', opts.page);
    const client = await clientFor(opts.profile);
    const { skills, total } = await client.listSkills({ kind: 'workflow', limit, page });

    if (opts.json) {
      console.log(safeJson({ workflows: skills, total }));
      return;
    }
    console.log(`Workflows (${skills.length}${total !== undefined ? ` of ${total}` : ''}):`);
    if (!skills.length) {
      console.log('  (none)');
      return;
    }
    for (const s of skills) {
      const id = stripControl(String(s.id ?? s._id ?? '?'));
      const triggers = Array.isArray(s.triggers) ? `${s.triggers.length} trigger(s)` : '';
      const line = `${id}  [${stripControl(String(s.workflowStatus ?? s.status ?? '?'))}/${stripControl(String(s.scheduleType ?? '?'))}]  ${stripControl(s.name ?? '?')}  ${stripControl(s.title ?? '')}  ${triggers}`;
      console.log(`  ${line.trimEnd()}`);
    }
  } catch (err: any) {
    fail(err);
  }
}

/**
 * agnt skill — CRUD for account skills (including knowledge skills) from the
 * terminal, over the same /skills REST surface agnt-console/agnt-studio/
 * agnt-portal already use (functions/agnt-api/controllers/skillsController.mjs).
 * No new backend — this is a client for what's already there.
 *
 * Two ways to write content:
 *   - `agnt skill create` / `agnt skill update` — flat fields (title,
 *     description, whenToUse, instructions). Good for a simple, single-blob
 *     knowledge skill. Cannot set multi-file content.
 *   - `agnt skill push <manifest.json>` — manifest-shaped create-or-update
 *     (POST /skills/import). The only path that can set multi-file content
 *     (spec.files[]). `agnt skill export` produces a manifest in the same
 *     shape, for a pull → edit → push round trip.
 *
 * A freshly created skill defaults to status:'draft', which is invisible to
 * Prime (the roster query filters status:'active') — create/push default to
 * --status active for that reason; pass --draft to opt out.
 *
 * Usage:
 *   agnt skill list [--kind knowledge] [--search <text>] [--profile <name>] [--json]
 *   agnt skill get <nameOrId> [--profile <name>] [--json]
 *   agnt skill create --title <t> [--name <slug>] [--kind knowledge]
 *                      [--description <d>] [--when-to-use <w>]
 *                      [--instructions <text> | --instructions-file <path>]
 *                      [--access private|public] [--draft]
 *                      [--profile <name>] [--json]
 *   agnt skill update <nameOrId> [--title <t>] [--description <d>]
 *                      [--when-to-use <w>] [--instructions <text> | --instructions-file <path>]
 *                      [--status draft|active|archived] [--access private|public]
 *                      [--profile <name>] [--json]
 *   agnt skill push <manifest.json> [--conflict skip|overwrite|merge] [--draft]
 *                      [--profile <name>] [--json]
 *   agnt skill export <nameOrId> [-o <file>] [--profile <name>]
 *   agnt skill publish <nameOrId> --environment <env> [--deploy] [--note <text>]
 *                      [--profile <name>] [--json]
 */

import { clientFor } from './run.js';
import { stripControl, safeJson } from './eval.js';
import type { AgntApiClient, SkillSummary, SkillManifest } from '../utils/api.js';

export interface SkillProfileOptions {
  profile?: string;
  json?: boolean;
}

function fail(err: any): never {
  console.error(err?.message ?? String(err));
  process.exit(1);
}

// Skill title/description/instructions can come from another account (a
// public store skill, or one 'grant'/'import'-installed rather than
// authored locally — skillsController.mjs's list()/show() serve those the
// same as your own). Same reasoning as eval.ts's stripControl on judge
// text: don't print unsanitized third-party text to a terminal.
function summaryLine(s: SkillSummary): string {
  const id = s.id ?? s._id ?? '?';
  const status = s.status ?? '?';
  const kind = s.kind ?? '?';
  const name = stripControl(s.name ?? '?');
  const title = stripControl(s.title ?? '');
  return `${id}  [${kind}/${status}]  ${name}  ${title}`.trimEnd();
}

// Mirrors skillsController.mjs's `isObjectId`.
function isObjectIdLike(v: string): boolean {
  return /^[a-f\d]{24}$/i.test(v);
}

// Server-side `q` substring-matches name OR title OR description
// (skillsController.mjs list()), sorted by install recency — not an exact
// name filter. Ask for the API's max page size so an exact-name match isn't
// missed just because other same-worded skills sort ahead of it.
const RESOLVE_SEARCH_LIMIT = 200;

/**
 * Resolve a skill by id OR name, always returning the full record fetched
 * BY ID. GET /skills/:idOrName's name branch (skillsController.mjs `show()`)
 * has a confirmed bug: it resolves `SkillInstall.findOne({account})` with NO
 * name filter at the query level (only a post-hoc `populate({match})`), so
 * on any account with more than a handful of skills it effectively 404s a
 * real skill by name (reproduced live against staging while building this
 * CLI: a name lookup 404'd for a skill that `GET /skills/<id>` served fine
 * seconds later). Work around it by resolving the id client-side through
 * GET /skills (list, `q` search — a real Skill.find query, not this bug),
 * then always fetching by id.
 */
async function resolveSkill(client: AgntApiClient, idOrName: string): Promise<SkillSummary> {
  if (isObjectIdLike(idOrName)) {
    return client.getSkill(idOrName);
  }
  const { skills } = await client.listSkills({ q: idOrName, limit: RESOLVE_SEARCH_LIMIT });
  const matches = skills.filter(s => s.name === idOrName);
  if (!matches.length) throw new Error(`Skill '${idOrName}' not found`);
  if (matches.length > 1) {
    // `name` is unique per account (schema index) — this should be
    // impossible, but resolveSkill exists specifically to defend against a
    // confirmed server-side lookup bug, so don't silently guess if the
    // account is ever in a state where it isn't.
    console.error(`Warning: ${matches.length} skills named '${idOrName}' — using the most recently installed one.`);
  }
  const id = matches[0].id ?? matches[0]._id;
  return client.getSkill(id);
}

// Derives a slug the way the backend requires (validateManifest in
// importSkillsFromManifest.mjs: /^[a-z0-9][a-z0-9-]*$/) when --name is
// omitted on create. Without this, `agnt skill create --title "..."` —
// exactly the form this file's own usage comment and index.ts's --name help
// text ("auto-derived from title if omitted") advertise — always 400s with
// "Invalid manifest: name is required", since create() routes through
// POST /skills/import and nothing else supplies a name.
function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface SkillListOptions extends SkillProfileOptions {
  kind?: string;
  search?: string;
  tier?: string;
  category?: string;
  limit?: string;
  page?: string;
}

export async function runSkillList(opts: SkillListOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const { skills, total } = await client.listSkills({
      kind: opts.kind,
      q: opts.search,
      tier: opts.tier,
      category: opts.category,
      limit: opts.limit ? Number(opts.limit) : undefined,
      page: opts.page ? Number(opts.page) : undefined,
    });

    if (opts.json) {
      console.log(safeJson({ skills, total }));
      return;
    }

    console.log(`Skills (${skills.length}${total !== undefined ? ` of ${total}` : ''}):`);
    if (!skills.length) {
      console.log('  (none)');
      return;
    }
    for (const s of skills) console.log(`  ${summaryLine(s)}`);
  } catch (err: any) {
    fail(err);
  }
}

// ── get ──────────────────────────────────────────────────────────────────────

export async function runSkillGet(idOrName: string, opts: SkillProfileOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const skill = await resolveSkill(client, idOrName);

    if (opts.json) {
      console.log(safeJson(skill));
      return;
    }

    console.log(summaryLine(skill));
    if (skill.description) console.log(`\n${stripControl(skill.description)}`);
    if (skill.whenToUse) console.log(`\nWhen to use: ${stripControl(skill.whenToUse)}`);
    if (skill.instructions) console.log(`\n--- instructions ---\n${stripControl(skill.instructions)}`);
    if (Array.isArray(skill.files) && skill.files.length) {
      console.log(`\nFiles: ${skill.files.map((f: any) => stripControl(String(f.path))).join(', ')}`);
    }
  } catch (err: any) {
    fail(err);
  }
}

// ── create / update (flat fields) ───────────────────────────────────────────

export interface SkillWriteOptions extends SkillProfileOptions {
  name?: string;
  title?: string;
  description?: string;
  whenToUse?: string;
  instructions?: string;
  instructionsFile?: string;
  kind?: string;
  access?: string;
  status?: string;
  draft?: boolean;
}

async function resolveInstructions(opts: SkillWriteOptions): Promise<string | undefined> {
  if (opts.instructionsFile) {
    const { readFile } = await import('fs/promises');
    return (await readFile(opts.instructionsFile, 'utf-8')).trim();
  }
  return opts.instructions;
}

// Both create and update below go through POST /skills/import
// (client.importSkill), NOT the flat POST/PATCH /skills endpoints, for two
// confirmed reasons:
//
// 1. CreateSkillBodySchema (functions/agnt-api/schemas/skills.schemas.mjs)
//    has no `status` field — POST /skills silently drops it (Zod's default
//    strip mode), so a skill created there always lands status:'draft'
//    regardless of what's sent. 'draft' is invisible to Prime (the roster
//    query filters status:'active'), so a plain POST /skills skill isn't
//    usable until promoted.
// 2. update()'s ownership guard (skillsController.mjs, the block right after
//    resolving `install`) refuses ANY edit — not just a status change —
//    from a non-console caller when the skill's origin isn't one of the
//    portal-* origins: `surface !== 'console' && !PORTAL_ORIGINS.includes(origin)`.
//    An apikey/CLI caller never carries surface:'console', and POST /skills
//    defaults a new skill's origin to 'studio' (Zod default) for exactly
//    this caller type — so PATCH /skills/:id on a CLI-created skill 403s
//    with "You can only edit skills you own" even though the calling
//    account genuinely owns it. Confirmed live against staging while
//    building this CLI (2026-09-23).
//
// importSkillsFromManifest.mjs (what POST /skills/import calls) has no such
// surface/origin gate — it's already account-scoped (`{account, name}`) and
// applies conflictStrategy directly, so it's the only path that reliably
// works for the apikey credential the CLI actually uses.

export async function runSkillCreate(opts: SkillWriteOptions): Promise<void> {
  if (!opts.title?.trim()) {
    console.error('Usage: agnt skill create --title <title> [--kind knowledge] [--description ...] [--when-to-use ...] [--instructions ... | --instructions-file <path>]');
    process.exit(1);
  }

  try {
    const instructions = await resolveInstructions(opts);
    const manifest: Record<string, any> = {
      name: opts.name || slugify(opts.title.trim()),
      title: opts.title.trim(),
      kind: opts.kind ?? 'knowledge',
      status: opts.status ?? (opts.draft ? 'draft' : 'active'),
    };
    if (opts.description) manifest.description = opts.description;
    if (opts.whenToUse) manifest.whenToUse = opts.whenToUse;
    if (instructions) manifest.instructions = instructions;
    if (opts.access) manifest.access = opts.access;

    const client = await clientFor(opts.profile);
    const result = await client.importSkill(manifest, 'skip');

    if (result.action === 'skipped') {
      console.error(`A skill named '${manifest.name ?? opts.title}' already exists — use 'agnt skill update' or 'agnt skill push --conflict overwrite'.`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(safeJson(result.skill));
      return;
    }
    console.log(`Created ${result.skill ? summaryLine(result.skill) : manifest.name}`);
  } catch (err: any) {
    fail(err);
  }
}

export async function runSkillUpdate(idOrName: string, opts: SkillWriteOptions): Promise<void> {
  try {
    const instructions = await resolveInstructions(opts);
    const fields: Record<string, any> = {};
    if (opts.name) fields.name = opts.name;
    if (opts.title) fields.title = opts.title;
    if (opts.description !== undefined) fields.description = opts.description;
    if (opts.whenToUse !== undefined) fields.whenToUse = opts.whenToUse;
    if (instructions !== undefined) fields.instructions = instructions;
    if (opts.kind) fields.kind = opts.kind;
    if (opts.access) fields.access = opts.access;
    if (opts.status) fields.status = opts.status;

    if (Object.keys(fields).length === 0) {
      console.error('Nothing to update — pass at least one of --title/--description/--when-to-use/--instructions/--instructions-file/--status/--access/--kind/--name');
      process.exit(1);
    }

    const client = await clientFor(opts.profile);
    // importSkill is keyed by `name`, not id, and validateManifest() requires
    // `kind` on every call (even when it isn't changing) — so always fetch
    // the current skill first, both to resolve an id→name (the caller may
    // have passed either) and to carry its existing `kind` forward. GET
    // /skills/:id has no surface/origin gate (read paths aren't affected by
    // the update() write-path bug above), so this is safe.
    const current = await resolveSkill(client, idOrName);
    if (!current?.name) throw new Error(`Could not resolve '${idOrName}'`);

    // 'overwrite', not 'merge': importSkillsFromManifest.mjs's 'merge' mode
    // explicitly SKIPS every key in PUBLISHING_FIELDS (status, access, tier,
    // listed, hidden, ...) to protect a full manifest re-import from
    // clobbering admin-managed fields it didn't intend to touch — but that
    // means a merge silently no-ops `--status`/`--access` (confirmed live:
    // `--status active` reported "Updated" while the skill stayed 'draft').
    // 'overwrite' only applies keys actually present in `fields` (nothing
    // else is in this manifest at all), so for a command that already only
    // ever sends what the caller explicitly asked to change, 'overwrite' is
    // the one that behaves like "update" — it carries none of overwrite's
    // usual "replaces everything" risk here.
    const result = await client.importSkill(
      { name: current.name, kind: fields.kind ?? current.kind, ...fields },
      'overwrite'
    );
    if (result.action === 'created') {
      // 'merge' still creates when the name doesn't exist yet (importSkillsFromManifest
      // has no separate "must already exist" mode) — shouldn't happen since we
      // just read `current` above, but say so plainly rather than silently
      // reporting "Updated" if the skill was deleted concurrently.
      console.error(`Warning: '${current.name}' was not found at write time — created a new skill instead.`);
    }

    if (opts.json) {
      console.log(safeJson(result.skill));
      return;
    }
    console.log(`${result.action === 'created' ? 'Created' : 'Updated'} ${result.skill ? summaryLine(result.skill) : current.name}`);
  } catch (err: any) {
    fail(err);
  }
}

// ── push (manifest import) ──────────────────────────────────────────────────

export interface SkillPushOptions extends SkillProfileOptions {
  conflict?: string;
  draft?: boolean;
}

/** `agnt pull` saves `{ manifest, pulledAt }`; a hand-authored manifest file
 *  (e.g. copied from interfaces/studio/agnt/*.json) IS the manifest at the
 *  top level. Accept both. */
function unwrapManifest(parsed: any): SkillManifest {
  if (parsed && typeof parsed === 'object' && parsed.manifest && typeof parsed.manifest === 'object') {
    return parsed.manifest;
  }
  return parsed;
}

export async function runSkillPush(file: string, opts: SkillPushOptions): Promise<void> {
  const conflictStrategy = (opts.conflict ?? 'overwrite') as 'skip' | 'overwrite' | 'merge';
  if (!['skip', 'overwrite', 'merge'].includes(conflictStrategy)) {
    console.error(`--conflict must be one of: skip, overwrite, merge (got "${opts.conflict}")`);
    process.exit(1);
  }

  try {
    const { readFile } = await import('fs/promises');
    const raw = await readFile(file, 'utf-8');
    const manifest = unwrapManifest(JSON.parse(raw));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`${file} must contain a JSON object (a manifest), not ${manifest === null ? 'null' : Array.isArray(manifest) ? 'an array' : typeof manifest}`);
    }

    // Same status:'draft'-is-invisible-to-Prime reasoning as create() — stamp
    // metadata.status unless the manifest already declares one or --draft
    // was asked for. A manifest can nest status under `metadata` or flat.
    if (!opts.draft) {
      const hasStatus = manifest.status !== undefined || manifest.metadata?.status !== undefined;
      if (!hasStatus) {
        if (manifest.metadata && typeof manifest.metadata === 'object') {
          manifest.metadata.status = 'active';
        } else {
          manifest.status = 'active';
        }
      }
    }

    const client = await clientFor(opts.profile);
    const result = await client.importSkill(manifest, conflictStrategy);

    if (opts.json) {
      console.log(safeJson(result));
      return;
    }
    if (result.action === 'skipped') {
      console.log(`Skipped — a skill with this name already exists (pass --conflict overwrite or --conflict merge). ${result.skill ? summaryLine(result.skill) : ''}`.trimEnd());
      return;
    }
    console.log(`${result.action === 'created' ? 'Created' : 'Updated'}${result.skill ? ` ${summaryLine(result.skill)}` : ''}`);
  } catch (err: any) {
    fail(err);
  }
}

// ── export ───────────────────────────────────────────────────────────────────

export interface SkillExportOptions {
  profile?: string;
  output?: string;
}

export async function runSkillExport(idOrName: string, opts: SkillExportOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const manifest = await client.exportSkill(idOrName);

    if (opts.output) {
      // Written to a file, not a terminal — no injection risk, and this is
      // meant to round-trip byte-for-byte with `agnt skill push`, so no
      // sanitization here (unlike the stdout branch below).
      const { writeFile } = await import('fs/promises');
      await writeFile(opts.output, JSON.stringify(manifest, null, 2), 'utf-8');
      console.error(`Exported ${idOrName} → ${opts.output}`);
    } else {
      // safeJson escapes rather than deletes (unlike stripControl), so this
      // still round-trips through `agnt skill push` if piped to a file.
      console.log(safeJson(manifest));
    }
  } catch (err: any) {
    fail(err);
  }
}

// ── publish ──────────────────────────────────────────────────────────────────

export interface SkillPublishOptions extends SkillProfileOptions {
  environment?: string;
  deploy?: boolean;
  note?: string;
}

export async function runSkillPublish(idOrName: string, opts: SkillPublishOptions): Promise<void> {
  if (!opts.environment?.trim()) {
    console.error('Usage: agnt skill publish <nameOrId> --environment <slug> [--deploy] [--note <text>]');
    process.exit(1);
  }

  try {
    const client = await clientFor(opts.profile);
    // publish only accepts a real ObjectId — resolve a name first.
    const skill = await resolveSkill(client, idOrName);
    const skillId = skill.id ?? skill._id;
    if (!skillId) throw new Error(`Could not resolve an id for '${idOrName}'`);

    const result = await client.publishSkill(skillId, {
      environment: opts.environment.trim(),
      deploy: opts.deploy,
      note: opts.note,
    });

    if (opts.json) {
      console.log(safeJson(result));
      return;
    }
    console.log(`Published version ${result.versionNumber} of '${skill.name}' to '${opts.environment}'${opts.deploy ? ' (deployed)' : ''}`);
  } catch (err: any) {
    fail(err);
  }
}

/**
 * agnt eval — read Run Review evaluations from the terminal: the same three
 * views as agnt-console → Evaluation, so an agent (or you) can go from "how are
 * runs doing" to one evaluation to the original task, chat and traces.
 *
 * Every review carries the ids of the run it scored. `agnt eval get` prints the
 * follow-up commands: `agnt run task <taskId>` for the full tool-call timeline,
 * `agnt run chat <chatId>` for the conversation, and the LangSmith query for
 * the trace.
 *
 * Needs an ACCOUNT-LEVEL API key: one created without a specific user and
 * without an org, the kind that gives `agnt run` account-wide visibility. A key
 * tied to a user or an org is refused: an evaluation is a cross-user view. A
 * key's scopes are not checked (nothing enforces them on any route, and every
 * key the console mints carries some).
 *
 * Usage:
 *   agnt eval summary [--days 30] [--profile <name>] [--json]
 *   agnt eval list [--days 30] [--task-class <class> | --unclassified]
 *                  [--outcome <category>] [--sentiment <ending>]
 *                  [--min-score <n>] [--max-score <n>]
 *                  [--sort worst|newest] [--page <n>] [--limit <n>]
 *                  [--profile <name>] [--json]
 *   agnt eval get <reviewId> [--profile <name>] [--json]
 */

import { clientFor } from './run.js';
import type { ListRunReviewsParams, RunReviewRecord, RunReviewSummary } from '../utils/api.js';

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 25;
/** The API clamps to these; asking for more would print a window or page size that was not served. */
const MAX_DAYS = 365;
const MAX_LIMIT = 100;
const SNIPPET_LEN = 240;
/** The list endpoint matches this `taskClass` value to reviews the judge left without a class. */
const UNCLASSIFIED_TASK_CLASS = '__unclassified__';

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * Judge text is model output shaped by end-user content, and it lands in a
 * terminal and in an agent's context. Drop what should not be displayed or read
 * invisibly: control characters (escape sequences that retitle a terminal or
 * clear the screen, carriage returns that overwrite a line), format characters
 * (bidi overrides that reorder text, zero-width characters, the invisible tag
 * block an LLM can read and a person cannot), and the Unicode line and
 * paragraph separators. Newline and tab stay, and so do the zero-width joiner
 * and non-joiner, which emoji sequences and some scripts need.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const KEPT_IN_TEXT = new Set(['\n', '\t', String.fromCharCode(0x200c), String.fromCharCode(0x200d)]);

export function stripControl(text: string): string {
  return text.replace(UNSAFE, ch => (KEPT_IN_TEXT.has(ch) ? ch : ''));
}

/**
 * JSON.stringify escapes only below U+0020, so the rest of what stripControl
 * removes would reach the terminal raw in --json output. Escape it instead: the
 * JSON stays valid and parses back to the same text. Newline is the pretty
 * printer's own line break, so it stays.
 */
export function safeJson(value: unknown): string {
  const backslash = String.fromCharCode(92);
  return JSON.stringify(value, null, 2).replace(UNSAFE, ch =>
    ch === '\n' ? ch : ch.split('').map(unit => `${backslash}u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  );
}

/**
 * Quote for a POSIX shell unless plainly safe, so a printed command is the
 * command that was meant when it is pasted. A leading = is quoted too: zsh, the
 * macOS default, expands it to a command path.
 */
export function shellQuote(value: string): string {
  return /^(?!=)[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A number to fixed places, or "?" for anything that is not a finite number. */
function fixed(n: unknown, places: number): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(places) : '?';
}

/** A 0 to 1 fraction as a percentage, or "?". */
function percent(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 100)}%` : '?';
}

/** The entries of an API field that should be a list: nulls dropped, a lone string kept, anything else nothing. */
function listOf(x: unknown): unknown[] {
  if (Array.isArray(x)) return x.filter(i => i != null);
  return typeof x === 'string' && x ? [x] : [];
}

/** The object entries of an API list, so one null or stray value does not stop the rest printing. */
function objectsOf(x: unknown): Record<string, any>[] {
  return Array.isArray(x) ? x.filter((i): i is Record<string, any> => !!i && typeof i === 'object') : [];
}

function oneLine(text: unknown, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stamp(value: unknown): string {
  const d = value ? new Date(String(value)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '?';
}

function score(n: unknown): string {
  return n == null ? '?' : `${n}/5`;
}

function personOf(user: unknown): string {
  if (!user || typeof user !== 'object') return '?';
  const u = user as Record<string, any>;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return name && u.email ? `${name} <${u.email}>` : name || u.email || '?';
}

function indent(text: unknown): string {
  return String(text).split('\n').map(l => `  ${l}`).join('\n');
}

function duration(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** " (4m 12s)" when both ends parse and run forwards, otherwise nothing. */
function spanOf(from: unknown, to: unknown): string {
  const ms = new Date(String(to)).getTime() - new Date(String(from)).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ` (${duration(ms)})` : '';
}

function pctOf(count: number, total: number): string {
  return total ? `${Math.round((count / total) * 100)}%` : '0%';
}

function bucketLine(buckets: unknown, total: number): string {
  return objectsOf(buckets).map(b => `${b._id ?? 'unscored'} ${b.count} (${pctOf(Number(b.count), total)})`).join(', ') || '(none)';
}

export function renderSummary(s: RunReviewSummary): string {
  const lines: string[] = [];
  lines.push(
    `Run reviews, last ${s.windowDays ?? '?'} days: ${s.count} reviewed, avg outcome ${fixed(s.avgOutcome, 2)}, ` +
      `avg experience ${fixed(s.avgExperience, 2)}, ${s.wouldComplain ?? '?'} would complain`,
  );
  lines.push(`Credits covered ${fixed(s.creditsReviewed, 0)}, judge cost $${fixed(s.judgeCostUsd, 2)}`);
  if (!s.count) return lines.join('\n');

  lines.push('', `Outcome: ${bucketLine(s.byCategory, s.count)}`);
  lines.push(`Ended:   ${bucketLine(s.bySentiment, s.count)}`);

  const groups = objectsOf(s.byTaskClass);
  if (groups.length) {
    const width = Math.max(...groups.map(g => String(g._id || 'unclassified').length));
    lines.push('', 'By task type:');
    for (const g of groups) {
      lines.push(
        `  ${String(g._id || 'unclassified').padEnd(width)}  ${String(g.count).padStart(4)} runs  ` +
          `outcome ${fixed(g.avgOutcome, 2)}  experience ${fixed(g.avgExperience, 2)}  ` +
          `credits ${fixed(g.avgCredits, 1)}`,
      );
    }
    lines.push('', 'Open a group with: agnt eval list --task-class <type>   (or --unclassified)');
  }
  return lines.join('\n');
}

export interface ListView {
  runReviews: RunReviewRecord[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export function renderList(view: ListView, params: ListRunReviewsParams, pageHint: string | null): string {
  const lines: string[] = [];
  const { page, perPage, total, totalPages } = view;
  const runReviews = objectsOf(view.runReviews);
  const pastEnd = total > 0 && page > totalPages;
  const first = total ? (page - 1) * perPage + 1 : 0;
  const last = Math.min(page * perPage, total);
  lines.push(
    `${total} review${total === 1 ? '' : 's'} (${params.sort === 'newest' ? 'newest' : 'worst'} first, last ${params.days ?? DEFAULT_DAYS} days)` +
      (pastEnd
        ? `, but page ${page} is past the last page (${totalPages})`
        : total ? `, showing ${first}-${last}, page ${page} of ${totalPages}` : ''),
  );

  for (const r of runReviews) {
    const v = r.review ?? {};
    const sideEffects = listOf(v.undesiredSideEffects).length;
    lines.push('');
    lines.push(
      [
        r._id,
        `outcome ${score(v.outcomeScore)}${v.outcomeCategory ? ` ${v.outcomeCategory}` : ''}`,
        `experience ${score(v.experienceScore)}`,
        `ended ${v.userSentimentEnd ?? '?'}`,
        v.taskClass || 'unclassified',
      ].join('  '),
    );
    lines.push(
      `    ${stamp(r.reviewedAt)}  task ${r.task ?? '-'}  chat ${r.chat ?? '-'}  credits ${r.creditsConsumed ?? '?'}` +
        (sideEffects ? `  ${sideEffects} undesired side effect${sideEffects === 1 ? '' : 's'}` : ''),
    );
    if (v.userPerspective) lines.push(`    "${oneLine(v.userPerspective, SNIPPET_LEN)}"`);
  }

  if (runReviews.length) lines.push('', 'Open one with: agnt eval get <reviewId>');
  if (pageHint) lines.push(...(runReviews.length ? [] : ['']), pageHint);
  return lines.join('\n');
}

export function renderReview(r: RunReviewRecord): string {
  const v = r.review ?? {};
  const lines: string[] = [];

  lines.push(`Review ${r._id}  ${v.taskClass || 'unclassified'}  ${stamp(r.reviewedAt)}`);
  lines.push(`User: ${personOf(r.user)}${r.originPlatform ? `   Platform: ${r.originPlatform}` : ''}`);
  lines.push(
    `Outcome ${score(v.outcomeScore)}${v.outcomeCategory ? ` (${v.outcomeCategory})` : ''}  ` +
      `Experience ${score(v.experienceScore)}${v.experienceConfidence != null ? ` (confidence ${percent(v.experienceConfidence)})` : ''}  ` +
      `Ended: ${v.userSentimentEnd ?? '?'}${v.sentimentTrajectory ? ` (${v.sentimentTrajectory})` : ''}  ` +
      `Would complain: ${v.wouldUserComplain == null ? '?' : v.wouldUserComplain ? 'yes' : 'no'}` +
      (v.wouldUserRecommend != null ? `  Recommend: ${v.wouldUserRecommend} (-2 to 2)` : ''),
  );

  const section = (title: string, body: unknown) => {
    if (body) lines.push('', `${title}:`, indent(body));
  };
  section('What they wanted', v.whatUserWanted);
  section('What they got', v.whatUserGot);
  section('In their words', v.userPerspective);

  const friction = listOf(v.frictionSignals);
  if (friction.length) lines.push('', `Friction: ${friction.join('; ')}`);
  const sideEffects = listOf(v.undesiredSideEffects);
  if (sideEffects.length) {
    lines.push('', 'Undesired side effects:');
    for (const item of sideEffects) {
      const e: Record<string, any> = typeof item === 'object' ? (item as Record<string, any>) : { what: String(item) };
      const tags = [e.reachedThirdParty && 'reached a third party', e.reversible === false && 'not reversible'].filter(Boolean);
      lines.push(`  - ${e.what}${tags.length ? ` (${tags.join(', ')})` : ''}`);
    }
  }
  if (v.faultAttribution) {
    lines.push('', `Fault: ${v.faultAttribution}${v.faultConfidence != null ? ` (confidence ${percent(v.faultConfidence)})` : ''}` +
      '   [the judge\'s own call, and the field most likely to be wrong]');
    if (v.faultEvidence) lines.push(indent(v.faultEvidence));
  }
  if (v.improvementHypothesis) {
    lines.push('', `What to look at${v.improvementSurface ? ` [${v.improvementSurface}]` : ''}:`, indent(v.improvementHypothesis));
  }
  const flags = listOf(v.flags);
  if (flags.length) lines.push('', `Flags: ${flags.join(', ')}`);

  lines.push('', 'Original run:');
  if (r.task) lines.push(`  task  ${r.task}    agnt run task ${shellQuote(String(r.task))}`);
  if (r.chat) lines.push(`  chat  ${r.chat}    agnt run chat ${shellQuote(String(r.chat))}`);
  lines.push(`  run   ${r.runRef}   (the execution id; the run logs under its first 8 characters)`);
  const facts = [
    r.runStatus && `status ${r.runStatus}`,
    r.turnCount != null && `${r.turnCount} turns`,
    r.toolCallCount != null && `${r.toolCallCount} tool calls`,
    r.creditsConsumed != null && `${r.creditsConsumed} credits`,
    r.runStartedAt && `${stamp(r.runStartedAt)}${r.runCompletedAt ? ` to ${stamp(r.runCompletedAt)}${spanOf(r.runStartedAt, r.runCompletedAt)}` : ''}`,
  ].filter(Boolean);
  if (facts.length) lines.push(`  ${facts.join(' · ')}`);
  if (r.task) {
    // Plain ids keep the double-quoted form the console's hint uses; anything else is quoted for the shell.
    const metadata = /^[\w-]+$/.test(String(r.task)) ? `"taskId=${r.task}"` : shellQuote(`taskId=${r.task}`);
    lines.push(
      `  LangSmith: langsmith run list --metadata ${metadata} --run-type llm --include-io` +
        '   # the id is an AGNT id, not a LangSmith UUID; `run get` a UUID from the list',
    );
  }

  const judge = [
    r.judgeModel && `${r.judgeModel}${r.judgeModelTier ? ` (${r.judgeModelTier})` : ''}`,
    r.judgePromptVersion && `prompt ${r.judgePromptVersion}`,
    r.judgeLatencyMs != null && duration(Number(r.judgeLatencyMs)),
    r.judgeCostUsd != null && `$${fixed(Number(r.judgeCostUsd), 4)}`,
  ].filter(Boolean);
  if (judge.length) lines.push('', `Judge: ${judge.join(' · ')}`);

  return lines.join('\n');
}

// ── commands ─────────────────────────────────────────────────────────────────

function fail(err: any): never {
  // The message can carry the server's response body: keep it off the terminal raw, like the rest.
  const message = stripControl(String(err?.message ?? err));
  console.error(message);
  if (/\((401|403)\)/.test(message)) {
    console.error(
      'Evaluations need an account-level API key: one created without a specific user and without an org. ' +
        'A key tied to a user or an org is refused. An API that predates evaluations refuses every key.',
    );
  }
  process.exit(1);
}

function positiveInt(raw: string | undefined, flag: string, fallback: number, max?: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number, got "${raw}"`);
  if (max !== undefined && n > max) throw new Error(`${flag} must be at most ${max}, got ${n}`);
  return n;
}

function scoreBound(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`${flag} must be a whole number from 1 to 5, got "${raw}"`);
  return n;
}

export interface EvalSummaryOptions {
  days?: string;
  profile?: string;
  json?: boolean;
}

export async function evalSummary(opts: EvalSummaryOptions): Promise<void> {
  try {
    const days = positiveInt(opts.days, '--days', DEFAULT_DAYS, MAX_DAYS);
    const client = await clientFor(opts.profile);
    const summary = await client.getRunReviewSummary(days);
    console.log(opts.json ? safeJson({ summary }) : stripControl(renderSummary(summary)));
  } catch (err) {
    fail(err);
  }
}

export interface EvalListOptions {
  days?: string;
  taskClass?: string;
  unclassified?: boolean;
  outcome?: string;
  sentiment?: string;
  minScore?: string;
  maxScore?: string;
  sort?: string;
  page?: string;
  limit?: string;
  profile?: string;
  json?: boolean;
}

/** The command line that fetches the next page: this one, with only --page changed. */
function nextPageCommand(opts: EvalListOptions, page: number): string {
  const parts = ['agnt eval list'];
  const flag = (name: string, value: string | undefined) => {
    if (value) parts.push(`--${name} ${shellQuote(value)}`);
  };
  flag('days', opts.days);
  flag('task-class', opts.taskClass);
  if (opts.unclassified) parts.push('--unclassified');
  flag('outcome', opts.outcome);
  flag('sentiment', opts.sentiment);
  flag('min-score', opts.minScore);
  flag('max-score', opts.maxScore);
  flag('sort', opts.sort);
  flag('limit', opts.limit);
  flag('profile', opts.profile);
  parts.push(`--page ${page}`);
  return parts.join(' ');
}

export async function evalList(opts: EvalListOptions): Promise<void> {
  try {
    if (opts.taskClass && opts.unclassified) throw new Error('Pass --task-class or --unclassified, not both');
    const sort = opts.sort ?? 'worst';
    if (sort !== 'worst' && sort !== 'newest') throw new Error(`--sort must be "worst" or "newest", got "${sort}"`);

    const params: ListRunReviewsParams = {
      days: positiveInt(opts.days, '--days', DEFAULT_DAYS, MAX_DAYS),
      page: positiveInt(opts.page, '--page', 1),
      limit: positiveInt(opts.limit, '--limit', DEFAULT_LIMIT, MAX_LIMIT),
      sort,
      taskClass: opts.unclassified ? UNCLASSIFIED_TASK_CLASS : opts.taskClass,
      outcomeCategory: opts.outcome,
      sentiment: opts.sentiment,
      minScore: scoreBound(opts.minScore, '--min-score'),
      maxScore: scoreBound(opts.maxScore, '--max-score'),
    };

    const client = await clientFor(opts.profile);
    const view = await client.listRunReviews(params);

    if (opts.json) {
      console.log(safeJson(view));
      return;
    }
    let pageHint: string | null = null;
    if (view.page < view.totalPages) pageHint = `Next page: ${nextPageCommand(opts, view.page + 1)}`;
    else if (view.total > 0 && view.page > view.totalPages) pageHint = `Last page: ${nextPageCommand(opts, view.totalPages)}`;
    console.log(stripControl(renderList(view, params, pageHint)));
  } catch (err) {
    fail(err);
  }
}

export interface EvalGetOptions {
  profile?: string;
  json?: boolean;
}

export async function evalGet(reviewId: string, opts: EvalGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const runReview = await client.getRunReview(reviewId);
    console.log(opts.json ? safeJson({ runReview }) : stripControl(renderReview(runReview)));
  } catch (err) {
    fail(err);
  }
}

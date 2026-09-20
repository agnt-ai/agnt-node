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
 * Needs an ACCOUNT-LEVEL API key (one created without a specific user), the same
 * kind that gives `agnt run` account-wide visibility. A user-scoped or
 * org-scoped key is refused: an evaluation is a cross-user view.
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
const SNIPPET_LEN = 240;
/** The list endpoint matches this `taskClass` value to reviews the judge left without a class. */
const UNCLASSIFIED_TASK_CLASS = '__unclassified__';

// ── rendering ────────────────────────────────────────────────────────────────

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
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function pctOf(count: number, total: number): string {
  return total ? `${Math.round((count / total) * 100)}%` : '0%';
}

function bucketLine(buckets: { _id: string | null; count: number }[] = [], total: number): string {
  return buckets.map(b => `${b._id ?? 'unscored'} ${b.count} (${pctOf(b.count, total)})`).join(', ') || '(none)';
}

export function renderSummary(s: RunReviewSummary): string {
  const lines: string[] = [];
  lines.push(
    `Run reviews, last ${s.windowDays} days: ${s.count} reviewed, avg outcome ${s.avgOutcome?.toFixed(2) ?? '?'}, ` +
      `avg experience ${s.avgExperience?.toFixed(2) ?? '?'}, ${s.wouldComplain} would complain`,
  );
  lines.push(`Credits covered ${s.creditsReviewed?.toFixed(0) ?? 0}, judge cost $${s.judgeCostUsd?.toFixed(2) ?? '0.00'}`);
  if (!s.count) return lines.join('\n');

  lines.push('', `Outcome: ${bucketLine(s.byCategory, s.count)}`);
  lines.push(`Ended:   ${bucketLine(s.bySentiment, s.count)}`);

  const groups: Record<string, any>[] = s.byTaskClass ?? [];
  if (groups.length) {
    const width = Math.max(...groups.map(g => String(g._id ?? 'unclassified').length));
    lines.push('', 'By task type:');
    for (const g of groups) {
      lines.push(
        `  ${String(g._id ?? 'unclassified').padEnd(width)}  ${String(g.count).padStart(4)} runs  ` +
          `outcome ${g.avgOutcome?.toFixed(2) ?? '?'}  experience ${g.avgExperience?.toFixed(2) ?? '?'}  ` +
          `credits ${g.avgCredits?.toFixed(1) ?? '?'}`,
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

export function renderList(view: ListView, params: ListRunReviewsParams, nextPageHint: string | null): string {
  const lines: string[] = [];
  const { runReviews, page, perPage, total, totalPages } = view;
  const first = total ? (page - 1) * perPage + 1 : 0;
  const last = Math.min(page * perPage, total);
  lines.push(
    `${total} review${total === 1 ? '' : 's'} (${params.sort === 'newest' ? 'newest' : 'worst'} first, last ${params.days ?? DEFAULT_DAYS} days)` +
      (total ? `, showing ${first}-${last}, page ${page} of ${totalPages}` : ''),
  );

  for (const r of runReviews) {
    const v = r.review ?? {};
    const sideEffects = v.undesiredSideEffects?.length ?? 0;
    lines.push('');
    lines.push(
      [
        r._id,
        `outcome ${score(v.outcomeScore)}${v.outcomeCategory ? ` ${v.outcomeCategory}` : ''}`,
        `experience ${score(v.experienceScore)}`,
        `ended ${v.userSentimentEnd ?? '?'}`,
        v.taskClass ?? 'unclassified',
      ].join('  '),
    );
    lines.push(
      `    ${stamp(r.reviewedAt)}  task ${r.task ?? '-'}  chat ${r.chat ?? '-'}  credits ${r.creditsConsumed ?? '?'}` +
        (sideEffects ? `  ${sideEffects} undesired side effect${sideEffects === 1 ? '' : 's'}` : ''),
    );
    if (v.userPerspective) lines.push(`    "${oneLine(v.userPerspective, SNIPPET_LEN)}"`);
  }

  if (runReviews.length) {
    lines.push('', 'Open one with: agnt eval get <reviewId>');
    if (nextPageHint) lines.push(`Next page: ${nextPageHint}`);
  }
  return lines.join('\n');
}

export function renderReview(r: RunReviewRecord): string {
  const v = r.review ?? {};
  const lines: string[] = [];

  lines.push(`Review ${r._id}  ${v.taskClass ?? 'unclassified'}  ${stamp(r.reviewedAt)}`);
  lines.push(`User: ${personOf(r.user)}${r.originPlatform ? `   Platform: ${r.originPlatform}` : ''}`);
  lines.push(
    `Outcome ${score(v.outcomeScore)}${v.outcomeCategory ? ` (${v.outcomeCategory})` : ''}  ` +
      `Experience ${score(v.experienceScore)}${v.experienceConfidence != null ? ` (confidence ${Math.round(v.experienceConfidence * 100)}%)` : ''}  ` +
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

  if (v.frictionSignals?.length) lines.push('', `Friction: ${v.frictionSignals.join('; ')}`);
  if (v.undesiredSideEffects?.length) {
    lines.push('', 'Undesired side effects:');
    for (const e of v.undesiredSideEffects) {
      const tags = [e.reachedThirdParty && 'reached a third party', e.reversible === false && 'not reversible'].filter(Boolean);
      lines.push(`  - ${e.what}${tags.length ? ` (${tags.join(', ')})` : ''}`);
    }
  }
  if (v.faultAttribution) {
    lines.push('', `Fault: ${v.faultAttribution}${v.faultConfidence != null ? ` (confidence ${Math.round(v.faultConfidence * 100)}%)` : ''}` +
      '   [the judge\'s own call, and the field most likely to be wrong]');
    if (v.faultEvidence) lines.push(indent(v.faultEvidence));
  }
  if (v.improvementHypothesis) {
    lines.push('', `What to look at${v.improvementSurface ? ` [${v.improvementSurface}]` : ''}:`, indent(v.improvementHypothesis));
  }
  if (v.flags?.length) lines.push('', `Flags: ${v.flags.join(', ')}`);

  lines.push('', 'Original run:');
  if (r.task) lines.push(`  task  ${r.task}    agnt run task ${r.task}`);
  if (r.chat) lines.push(`  chat  ${r.chat}    agnt run chat ${r.chat}`);
  lines.push(`  run   ${r.runRef}   (the execution id; the run logs under its first 8 characters)`);
  const facts = [
    r.runStatus && `status ${r.runStatus}`,
    r.turnCount != null && `${r.turnCount} turns`,
    r.toolCallCount != null && `${r.toolCallCount} tool calls`,
    r.creditsConsumed != null && `${r.creditsConsumed} credits`,
    r.runStartedAt && `${stamp(r.runStartedAt)}${r.runCompletedAt ? ` to ${stamp(r.runCompletedAt)} (${duration(new Date(r.runCompletedAt).getTime() - new Date(r.runStartedAt).getTime())})` : ''}`,
  ].filter(Boolean);
  if (facts.length) lines.push(`  ${facts.join(' · ')}`);
  if (r.task) {
    lines.push(
      `  LangSmith: langsmith run list --metadata "taskId=${r.task}" --run-type llm --include-io` +
        '   # the id is an AGNT id, not a LangSmith UUID; `run get` a UUID from the list',
    );
  }

  const judge = [
    r.judgeModel && `${r.judgeModel}${r.judgeModelTier ? ` (${r.judgeModelTier})` : ''}`,
    r.judgePromptVersion && `prompt ${r.judgePromptVersion}`,
    r.judgeLatencyMs != null && duration(r.judgeLatencyMs),
    r.judgeCostUsd != null && `$${Number(r.judgeCostUsd).toFixed(4)}`,
  ].filter(Boolean);
  if (judge.length) lines.push('', `Judge: ${judge.join(' · ')}`);

  return lines.join('\n');
}

// ── commands ─────────────────────────────────────────────────────────────────

function fail(err: any): never {
  const message = String(err?.message ?? err);
  console.error(message);
  if (/\((401|403)\)/.test(message)) {
    console.error(
      'Evaluations need an account-level API key (one created without a specific user). ' +
        'A user-scoped or org-scoped key is refused. Check the key behind this profile.',
    );
  }
  process.exit(1);
}

function positiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number, got "${raw}"`);
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
    const days = positiveInt(opts.days, '--days', DEFAULT_DAYS);
    const client = await clientFor(opts.profile);
    const summary = await client.getRunReviewSummary(days);
    console.log(opts.json ? JSON.stringify({ summary }, null, 2) : renderSummary(summary));
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
function nextPageCommand(opts: EvalListOptions, nextPage: number): string {
  const parts = ['agnt eval list'];
  if (opts.days) parts.push(`--days ${opts.days}`);
  if (opts.taskClass) parts.push(`--task-class ${opts.taskClass}`);
  if (opts.unclassified) parts.push('--unclassified');
  if (opts.outcome) parts.push(`--outcome ${opts.outcome}`);
  if (opts.sentiment) parts.push(`--sentiment ${opts.sentiment}`);
  if (opts.minScore) parts.push(`--min-score ${opts.minScore}`);
  if (opts.maxScore) parts.push(`--max-score ${opts.maxScore}`);
  if (opts.sort) parts.push(`--sort ${opts.sort}`);
  if (opts.limit) parts.push(`--limit ${opts.limit}`);
  if (opts.profile) parts.push(`--profile ${opts.profile}`);
  parts.push(`--page ${nextPage}`);
  return parts.join(' ');
}

export async function evalList(opts: EvalListOptions): Promise<void> {
  try {
    if (opts.taskClass && opts.unclassified) throw new Error('Pass --task-class or --unclassified, not both');
    const sort = opts.sort ?? 'worst';
    if (sort !== 'worst' && sort !== 'newest') throw new Error(`--sort must be "worst" or "newest", got "${sort}"`);

    const params: ListRunReviewsParams = {
      days: positiveInt(opts.days, '--days', DEFAULT_DAYS),
      page: positiveInt(opts.page, '--page', 1),
      limit: positiveInt(opts.limit, '--limit', DEFAULT_LIMIT),
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
      console.log(JSON.stringify(view, null, 2));
      return;
    }
    const hasNext = view.page < view.totalPages;
    console.log(renderList(view, params, hasNext ? nextPageCommand(opts, view.page + 1) : null));
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
    console.log(opts.json ? JSON.stringify({ runReview }, null, 2) : renderReview(runReview));
  } catch (err) {
    fail(err);
  }
}

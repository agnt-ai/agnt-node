/**
 * agnt eval — the CLI's read of Run Review evaluations.
 *
 * These pin what an agent depends on: the request each command makes (filters
 * under the API's names, the key as a bearer token, page one worst first by
 * default), that every review names the task and chat it is about in full so it
 * can be followed with `agnt run`, and that a refused key gets told why.
 * fetch and the credentials profile are stubbed; the command, client and
 * renderers are the real ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../cli/utils/credentials.js', () => ({
  resolveProfile: async () => ({ apiUrl: 'https://api.test/', apiKey: 'ak_live_test' }),
}));

import { evalGet, evalList, evalSummary, shellQuote, stripControl } from '../cli/commands/eval.js';

const TASK = '64b0000000000000aaaaaaaa';
const CHAT = '64b0000000000000bbbbbbbb';
const RUN = '64b0000000000000cccccccc';
const REVIEW_ID = '64b000000000000000000001';

const review = (over: Record<string, any> = {}) => ({
  _id: REVIEW_ID,
  task: TASK,
  chat: CHAT,
  runRef: RUN,
  originPlatform: 'email',
  turnCount: 12,
  toolCallCount: 30,
  creditsConsumed: 106,
  runStatus: 'completed',
  runStartedAt: '2026-09-20T15:00:00.000Z',
  runCompletedAt: '2026-09-20T15:04:12.000Z',
  reviewedAt: '2026-09-21T02:00:00.000Z',
  user: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.test' },
  judgeModel: 'test-judge',
  judgeModelTier: 'medium',
  judgePromptVersion: '2026-08-27.1',
  judgeLatencyMs: 4200,
  judgeCostUsd: 0.0123,
  review: {
    taskClass: 'schedule_meeting_multi_participant',
    outcomeScore: 1,
    outcomeCategory: 'failed',
    experienceScore: 2,
    experienceConfidence: 0.6,
    userSentimentEnd: 'confused',
    sentimentTrajectory: 'declining',
    wouldUserComplain: true,
    wouldUserRecommend: -1,
    whatUserWanted: 'Find a time that avoids Tuesday.',
    whatUserGot: 'Three options, two of them on Tuesday.\nAnd a confusing final update.',
    userPerspective: 'They would say the assistant ignored the one constraint they gave.',
    frictionSignals: ['repeated the constraint', 'asked what happened'],
    undesiredSideEffects: [{ what: 'Sent options on a ruled-out day', reachedThirdParty: true, reversible: false }],
    faultAttribution: 'system',
    faultConfidence: 0.8,
    faultEvidence: 'The second email lists Tuesday 2pm.',
    improvementHypothesis: 'The hard-window constraint is not carried into the options step.',
    improvementSurface: 'prompt',
    flags: ['hard_window'],
    ...(over.review ?? {}),
  },
  ..._without(over, 'review'),
});

function _without(o: Record<string, any>, key: string) {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

let fetchMock: ReturnType<typeof vi.fn>;
let out: string[];
let err: string[];

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

const requested = () => new URL(String(fetchMock.mock.calls[0][0]));
const printed = () => out.join('\n');

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const page = (runReviews: any[], over: Record<string, any> = {}) => ({
  ok: true, runReviews, page: 1, perPage: 25, total: runReviews.length, totalPages: 1, ...over,
});

describe('agnt eval list', () => {
  it('asks for page one, worst first, 25 a page, over 30 days, with the key as a bearer token', async () => {
    respond(page([review()]));
    await evalList({});
    const url = requested();
    expect(url.origin + url.pathname).toBe('https://api.test/account/run-reviews');
    expect(Object.fromEntries(url.searchParams)).toEqual({ days: '30', page: '1', limit: '25', sort: 'worst' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ak_live_test' });
  });

  it('passes each filter under the name the API uses', async () => {
    respond(page([]));
    await evalList({
      days: '7', taskClass: 'research_company', outcome: 'failed', sentiment: 'angry',
      minScore: '1', maxScore: '2', sort: 'newest', page: '3', limit: '50',
    });
    expect(Object.fromEntries(requested().searchParams)).toEqual({
      days: '7', page: '3', limit: '50', sort: 'newest', taskClass: 'research_company',
      outcomeCategory: 'failed', sentiment: 'angry', minScore: '1', maxScore: '2',
    });
  });

  it('--unclassified asks for reviews with no task type', async () => {
    respond(page([]));
    await evalList({ unclassified: true });
    expect(requested().searchParams.get('taskClass')).toBe('__unclassified__');
  });

  it('refuses bad input before making any request', async () => {
    for (const bad of [
      { taskClass: 'x', unclassified: true },
      { sort: 'oldest' },
      { page: '0' },
      { days: 'soon' },
      { limit: '2.5' },
      { maxScore: '9' },
      { minScore: '0' },
    ]) {
      await expect(evalList(bad)).rejects.toThrow('exit 1');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.length).toBe(7);
  });

  it('names the review, task and chat of each row in full, so each can be followed', async () => {
    respond(page([review()], { total: 1 }));
    await evalList({});
    expect(printed()).toContain(REVIEW_ID);
    expect(printed()).toContain(`task ${TASK}`);
    expect(printed()).toContain(`chat ${CHAT}`);
    expect(printed()).toContain('outcome 1/5 failed');
    expect(printed()).toContain('agnt eval get <reviewId>');
  });

  it('cuts the judge text to a snippet in the list, on one line', async () => {
    const long = 'word '.repeat(200);
    respond(page([review({ review: { userPerspective: long } })]));
    await evalList({});
    const snippet = out.join('\n').split('\n').find(l => l.trim().startsWith('"'))!;
    expect(snippet.length).toBeLessThan(260);
    expect(snippet.endsWith('…"')).toBe(true);
  });

  it('gives the command for the next page, keeping the filters, and none on the last page', async () => {
    respond(page([review()], { page: 2, total: 60, totalPages: 3 }));
    await evalList({ taskClass: 'research_company', outcome: 'failed', page: '2', profile: 'prod' });
    expect(printed()).toContain('showing 26-50, page 2 of 3');
    expect(printed()).toContain('Next page: agnt eval list --task-class research_company --outcome failed --profile prod --page 3');

    out.length = 0;
    respond(page([review()], { page: 3, total: 60, totalPages: 3 }));
    await evalList({ page: '3' });
    expect(printed()).not.toContain('Next page');
  });

  it('says so when nothing matches', async () => {
    respond(page([]));
    await evalList({ taskClass: 'nothing' });
    expect(printed()).toContain('0 reviews');
    expect(printed()).not.toContain('Open one with');
  });

  it('--json prints the page as the API returned it', async () => {
    respond(page([review()], { total: 1 }));
    await evalList({ json: true });
    const parsed = JSON.parse(printed());
    expect(parsed.runReviews[0]._id).toBe(REVIEW_ID);
    expect(parsed.total).toBe(1);
    expect(printed()).not.toContain('Open one with');
  });
});

describe('agnt eval get', () => {
  it('fetches the review by id', async () => {
    respond({ ok: true, runReview: review() });
    await evalGet(REVIEW_ID, {});
    expect(requested().pathname).toBe(`/account/run-reviews/${REVIEW_ID}`);
  });

  it('prints the whole evaluation, not a snippet', async () => {
    respond({ ok: true, runReview: review() });
    await evalGet(REVIEW_ID, {});
    const text = printed();
    expect(text).toContain('Find a time that avoids Tuesday.');
    expect(text).toContain('Three options, two of them on Tuesday.');
    expect(text).toContain('And a confusing final update.');
    expect(text).toContain('ignored the one constraint');
    expect(text).toContain('Sent options on a ruled-out day (reached a third party, not reversible)');
    expect(text).toContain('Fault: system (confidence 80%)');
    expect(text).toContain('The second email lists Tuesday 2pm.');
    expect(text).toContain('What to look at [prompt]');
    expect(text).toContain('Pat Lee <pat@example.test>');
    expect(text).toContain('Judge: test-judge (medium)');
  });

  it('gives the commands that open the original run and its trace', async () => {
    respond({ ok: true, runReview: review() });
    await evalGet(REVIEW_ID, {});
    const text = printed();
    expect(text).toContain(`agnt run task ${TASK}`);
    expect(text).toContain(`agnt run chat ${CHAT}`);
    expect(text).toContain(RUN);
    expect(text).toContain(`langsmith run list --metadata "taskId=${TASK}"`);
    expect(text).toContain('4m 12s');
  });

  it('leaves out the chat command for a run that had no chat', async () => {
    respond({ ok: true, runReview: review({ chat: null }) });
    await evalGet(REVIEW_ID, {});
    expect(printed()).toContain(`agnt run task ${TASK}`);
    expect(printed()).not.toContain('agnt run chat');
  });

  it('--json prints the record as the API returned it', async () => {
    respond({ ok: true, runReview: review() });
    await evalGet(REVIEW_ID, { json: true });
    expect(JSON.parse(printed()).runReview.task).toBe(TASK);
  });

  it('says a missing review is missing, and exits non-zero', async () => {
    respond({ status: 404, error: 'Run review not found' }, 404);
    await expect(evalGet(REVIEW_ID, {})).rejects.toThrow('exit 1');
    expect(err.join('\n')).toContain('404');
    expect(err.join('\n')).not.toContain('account-level');
  });

  it('tells a refused key why', async () => {
    for (const status of [401, 403]) {
      err.length = 0;
      respond({ status, error: 'nope' }, status);
      await expect(evalGet(REVIEW_ID, {})).rejects.toThrow('exit 1');
      expect(err.join('\n')).toContain('account-level API key');
    }
  });
});

describe('agnt eval summary', () => {
  const summary = {
    windowDays: 30, count: 171, avgOutcome: 2.42, avgExperience: 2.57, wouldComplain: 31,
    creditsReviewed: 16023, judgeCostUsd: 1.234,
    byCategory: [{ _id: 'failed', count: 60 }, { _id: 'success', count: 111 }],
    bySentiment: [{ _id: 'neutral', count: 100 }, { _id: null, count: 71 }],
    byTaskClass: [
      { _id: 'schedule_meeting_multi_participant', count: 100, avgOutcome: 2.1, avgExperience: 2.3, avgCredits: 93.7 },
      { _id: null, count: 5, avgOutcome: null, avgExperience: null, avgCredits: null },
    ],
  };

  it('asks for the window and prints the buckets and the by-task-type rows', async () => {
    respond({ ok: true, summary });
    await evalSummary({ days: '90' });
    expect(requested().pathname).toBe('/account/run-reviews/summary');
    expect(requested().searchParams.get('days')).toBe('90');
    const text = printed();
    expect(text).toContain('171 reviewed');
    expect(text).toContain('failed 60 (35%)');
    expect(text).toContain('unscored 71 (42%)');
    expect(text).toContain('schedule_meeting_multi_participant');
    expect(text).toContain('unclassified');
    expect(text).toContain('agnt eval list --task-class <type>');
  });

  it('prints just the header when nothing was reviewed', async () => {
    respond({ ok: true, summary: { ...summary, count: 0, byTaskClass: [] } });
    await evalSummary({});
    expect(printed()).toContain('0 reviewed');
    expect(printed()).not.toContain('By task type');
  });
});

// ── hardening: what a review's text and a class name can do once printed ─────

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CR = String.fromCharCode(13);
const CONTROL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/;

describe('printed text is safe to paste and to display', () => {
  it('shellQuote leaves plain values alone and quotes everything else', () => {
    for (const plain of ['research_company', 'a.b-c:1', 'ak_live', '30']) expect(shellQuote(plain)).toBe(plain);
    expect(shellQuote('research company')).toBe("'research company'");
    expect(shellQuote('a; touch X')).toBe("'a; touch X'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });

  it('the next-page command quotes every value it repeats', async () => {
    respond(page([review()], { page: 1, total: 60, totalPages: 3 }));
    await evalList({ taskClass: 'research company; touch X', outcome: "it's", profile: 'my prof' });
    expect(printed()).toContain("--task-class 'research company; touch X'");
    expect(printed()).toContain("--outcome 'it'\\''s'");
    expect(printed()).toContain("--profile 'my prof'");
    expect(printed()).toContain('--page 2');
  });

  it('stripControl drops escapes, bells and carriage returns and keeps newline and tab', () => {
    expect(stripControl(`a${ESC}[2Jb${BEL}c${CR}d\ne\tf`)).toBe('a[2Jbcd\ne\tf');
  });

  it('a review cannot retitle the terminal or clear the screen through its text', async () => {
    const evil = `line one${ESC}]0;pwned${BEL}${ESC}[2J${CR}overwritten\nline two`;
    const record = review({
      review: { userPerspective: evil, whatUserWanted: evil, faultEvidence: evil, taskClass: `cls${ESC}[31m` },
    });

    respond(page([record]));
    await evalList({});
    expect(printed()).not.toMatch(CONTROL);
    expect(printed()).toContain('overwritten');

    out.length = 0;
    respond({ ok: true, runReview: record });
    await evalGet(REVIEW_ID, {});
    expect(printed()).not.toMatch(CONTROL);
    expect(printed()).toContain('line two');

    out.length = 0;
    respond({ ok: true, summary: { windowDays: 30, count: 1, wouldComplain: 0, byCategory: [{ _id: `x${ESC}[2J`, count: 1 }], bySentiment: [], byTaskClass: [] } });
    await evalSummary({});
    expect(printed()).not.toMatch(CONTROL);
  });

  it('--json escapes control characters rather than printing them raw', async () => {
    respond(page([review({ review: { userPerspective: `x${ESC}[2Jy` } })]));
    await evalList({ json: true });
    expect(printed()).not.toMatch(CONTROL);
    expect(JSON.parse(printed()).runReviews[0].review.userPerspective).toBe(`x${ESC}[2Jy`);
  });
});

describe('the edges of a list and of a review', () => {
  it('says a page past the end is past the end, and gives the last page', async () => {
    respond(page([], { page: 9, total: 60, totalPages: 3 }));
    await evalList({ page: '9', taskClass: 'research_company' });
    expect(printed()).toContain('60 reviews');
    expect(printed()).toContain('page 9 is past the last page (3)');
    expect(printed()).not.toContain('showing');
    expect(printed()).toContain('Last page: agnt eval list --task-class research_company --page 3');
  });

  it('refuses a window or a page size the API would clamp, before any request', async () => {
    for (const bad of [{ days: '366' }, { limit: '101' }]) await expect(evalList(bad)).rejects.toThrow('exit 1');
    await expect(evalSummary({ days: '366' })).rejects.toThrow('exit 1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('at most 365');
    expect(err.join('\n')).toContain('at most 100');
  });

  it('accepts the largest window and page size', async () => {
    respond(page([]));
    await evalList({ days: '365', limit: '100' });
    expect(requested().searchParams.get('days')).toBe('365');
    expect(requested().searchParams.get('limit')).toBe('100');
  });

  it('calls a blank task type "unclassified" in the summary, the list and one review', async () => {
    respond({ ok: true, summary: { windowDays: 30, count: 3, wouldComplain: 0, byCategory: [], bySentiment: [],
      byTaskClass: [{ _id: '', count: 2, avgOutcome: 3, avgExperience: 3, avgCredits: 1 }, { _id: null, count: 1, avgOutcome: 3, avgExperience: 3, avgCredits: 1 }] } });
    await evalSummary({});
    expect(printed().match(/unclassified/g)!.length).toBeGreaterThanOrEqual(3);

    out.length = 0;
    respond(page([review({ review: { taskClass: '' } })]));
    await evalList({});
    expect(printed()).toContain('ended confused  unclassified');

    out.length = 0;
    respond({ ok: true, runReview: review({ review: { taskClass: '' } }) });
    await evalGet(REVIEW_ID, {});
    expect(printed()).toContain('  unclassified  ');
  });

  it('stops on a response of the wrong shape rather than crash or print an empty object', async () => {
    for (const run of [
      () => evalList({}),
      () => evalList({ json: true }),
      () => evalGet(REVIEW_ID, {}),
      () => evalGet(REVIEW_ID, { json: true }),
      () => evalSummary({}),
      () => evalSummary({ json: true }),
    ]) {
      err.length = 0;
      out.length = 0;
      respond({ ok: true });
      await expect(run()).rejects.toThrow('exit 1');
      expect(err.join('\n')).toContain('Unexpected response');
      expect(out).toEqual([]);
    }
  });

  it('leaves out a run duration it cannot compute', async () => {
    respond({ ok: true, runReview: review({ runCompletedAt: 'not a date', runStartedAt: '2026-09-20T15:00:00.000Z' }) });
    await evalGet(REVIEW_ID, {});
    expect(printed()).not.toContain('NaN');
    expect(printed()).toContain('status completed');
  });

  it('tells a refused key about scopes as well as users and orgs', async () => {
    respond({ status: 403, error: 'nope' }, 403);
    await expect(evalGet(REVIEW_ID, {})).rejects.toThrow('exit 1');
    expect(err.join('\n')).toContain('unrestricted account-level API key');
    expect(err.join('\n')).toContain('limited to named scopes');
  });
});

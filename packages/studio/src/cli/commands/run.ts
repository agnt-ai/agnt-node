/**
 * agnt run — pull task/chat run detail from the DB via API (no bastion, no log scraping)
 *
 * Uses the same /tasks and /chats endpoints the agnt-console developer view
 * already uses — an account-level API key gets the same account-wide
 * visibility a console session does (see agnt-backend#3059). There is no
 * separate admin surface: this is just another client of the existing API.
 *
 * Usage:
 *   agnt run list [--since 24h] [--status active] [--limit 50] [--profile <name>] [--json]
 *   agnt run task <taskId> [--profile <name>] [--json]
 *   agnt run chat <chatId> [--profile <name>] [--json]
 */

import { resolveProfile } from '../utils/credentials.js';
import { AgntApiClient, type TaskSummary, type ChatSummary, type Activity } from '../utils/api.js';

const TRUNCATE_LEN = 400;
const DEFAULT_MAX_ACTIVITIES = 1000;
const PAGE_SIZE = 100;

type FetchPage = (before?: string) => Promise<{ activities: Activity[]; hasMore: boolean; cursor: string | null }>;

// Both /tasks/:id/activities and /chats/:id/activities page backward
// (newest-first, `before` cursor). Agentic tool loops can run into the
// thousands of activities, so this loops until hasMore is false or `max`
// is hit — never silently caps at one page. Concatenating pages in fetch
// order (each page itself newest-first) keeps the whole thing newest-first;
// reversed once at the end for chronological display.
async function fetchAllActivities(
  fetchPage: FetchPage,
  { max, all }: { max: number; all: boolean }
): Promise<{ activities: Activity[]; truncated: boolean }> {
  const pages: Activity[][] = [];
  let cursor: string | undefined;
  let total = 0;
  let truncated = false;

  while (true) {
    const { activities, hasMore, cursor: nextCursor } = await fetchPage(cursor);
    pages.push(activities);
    total += activities.length;

    if (!hasMore) break;
    if (!all && total >= max) {
      truncated = true;
      break;
    }
    if (!nextCursor) break; // defensive: hasMore true but no cursor shouldn't happen
    cursor = nextCursor;
  }

  return { activities: pages.flat().reverse(), truncated };
}

function truncate(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return '';
  return str.length > TRUNCATE_LEN ? `${str.slice(0, TRUNCATE_LEN)}… (${str.length} chars)` : str;
}

// "24h" / "45m" / "2d" / an ISO timestamp -> a Date to filter client-side by.
// The API has no server-side time-window filter, so `--since` is applied
// after fetching the newest page — this just bounds what gets printed.
function parseSince(raw: string): Date {
  const match = /^(\d+)(h|m|d)?$/.exec(raw.trim());
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2] || 'h';
    const ms = unit === 'm' ? amount * 60_000 : unit === 'd' ? amount * 86_400_000 : amount * 3_600_000;
    return new Date(Date.now() - ms);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid --since value: "${raw}"`);
  return parsed;
}

function renderActivity(activity: Record<string, any>): void {
  const time = activity.createdAt ? new Date(activity.createdAt).toISOString() : '?';

  if (activity.type === 'tool_turn' && activity.toolTurn) {
    const { textContent, toolCalls = [], toolResults = [] } = activity.toolTurn;
    if (textContent) console.log(`[${time}] assistant: ${truncate(textContent)}`);
    for (const call of toolCalls) {
      console.log(`[${time}]   → ${call.name}(${truncate(call.input)})`);
      const result = toolResults.find((r: any) => r.toolCallId === call.id);
      if (result) {
        const marker = result.isError ? 'ERROR' : 'ok';
        console.log(`[${time}]   ← [${marker}] ${truncate(result.content)}`);
      }
    }
    return;
  }

  if (activity.type === 'message' && activity.message) {
    console.log(`[${time}] message from=${activity.message.from ?? '?'}: ${truncate(activity.message.content)}`);
    return;
  }

  console.log(`[${time}] ${activity.type}`);
}

async function clientFor(profile?: string): Promise<AgntApiClient> {
  const { apiUrl, apiKey } = await resolveProfile(profile);
  return new AgntApiClient({ apiUrl, serviceKey: apiKey });
}

export interface RunListOptions {
  since?: string;
  status?: string;
  limit?: string;
  profile?: string;
  json?: boolean;
}

export async function runList(opts: RunListOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const perPage = opts.limit ? Number(opts.limit) : 50;
    const since = opts.since ? parseSince(opts.since) : null;

    const [{ tasks }, { chats }] = await Promise.all([
      client.listTasks({ status: opts.status, perPage }),
      client.listChats({ status: opts.status, perPage }),
    ]);

    const recentTasks = since ? tasks.filter(t => new Date(t.updatedAt ?? t.createdAt) >= since) : tasks;
    const recentChats = since ? chats.filter(c => new Date(c.lastMessageAt ?? c.updatedAt ?? c.createdAt) >= since) : chats;

    if (opts.json) {
      console.log(JSON.stringify({ tasks: recentTasks, chats: recentChats }, null, 2));
      return;
    }

    console.log(`Tasks (${recentTasks.length}${since ? ` since ${since.toISOString()}` : ''}):`);
    renderSummaryList(recentTasks, (t: TaskSummary) => `${t.id}  [${t.status}]  ${t.title ?? ''}`.trimEnd());
    console.log(`\nChats (${recentChats.length}${since ? ` since ${since.toISOString()}` : ''}):`);
    renderSummaryList(recentChats, (c: ChatSummary) => `${c.id}  [${c.status}]  ${c.title ?? ''}`.trimEnd());
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

function renderSummaryList<T>(items: T[], line: (item: T) => string): void {
  if (!items.length) {
    console.log('  (none)');
    return;
  }
  for (const item of items) console.log(`  ${line(item)}`);
}

export interface RunGetOptions {
  profile?: string;
  json?: boolean;
  max?: string;
  all?: boolean;
}

function warnIfTruncated(truncated: boolean, fetchedCount: number): void {
  if (truncated) {
    console.error(`(showing the most recent ${fetchedCount} activities — pass --all to fetch everything, or --max <n> to raise the cap)`);
  }
}

export async function runGetTask(taskId: string, opts: RunGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const max = opts.max ? Number(opts.max) : DEFAULT_MAX_ACTIVITIES;
    const [task, { activities, truncated }] = await Promise.all([
      client.getTask(taskId),
      fetchAllActivities(
        before => client.getTaskActivities(taskId, { limit: PAGE_SIZE, before }),
        { max, all: !!opts.all }
      ),
    ]);

    if (opts.json) {
      console.log(JSON.stringify({ task, activities, truncated }, null, 2));
      return;
    }

    console.log(`Task ${task.id}  [${task.status}]  ${task.title ?? ''}`.trimEnd());
    console.log(`Owner: ${task.ownerEmail ?? '?'}`);
    warnIfTruncated(truncated, activities.length);
    console.log('');
    for (const activity of activities) renderActivity(activity);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

export async function runGetChat(chatId: string, opts: RunGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const max = opts.max ? Number(opts.max) : DEFAULT_MAX_ACTIVITIES;
    const [chat, { activities, truncated }] = await Promise.all([
      client.getChat(chatId),
      fetchAllActivities(
        before => client.getChatActivities(chatId, { limit: PAGE_SIZE, before }),
        { max, all: !!opts.all }
      ),
    ]);

    if (opts.json) {
      console.log(JSON.stringify({ chat, activities, truncated }, null, 2));
      return;
    }

    console.log(`Chat ${chat.id}  [${chat.status}]  ${chat.title ?? ''}`.trimEnd());
    warnIfTruncated(truncated, activities.length);
    console.log('');
    for (const activity of activities) renderActivity(activity);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

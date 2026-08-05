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
import { AgntApiClient, type TaskSummary, type ChatSummary } from '../utils/api.js';

const TRUNCATE_LEN = 400;

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
}

export async function runGetTask(taskId: string, opts: RunGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const [task, { activities }] = await Promise.all([
      client.getTask(taskId),
      client.getTaskActivities(taskId, { limit: 100 }),
    ]);
    const chronological = [...activities].reverse();

    if (opts.json) {
      console.log(JSON.stringify({ task, activities: chronological }, null, 2));
      return;
    }

    console.log(`Task ${task.id}  [${task.status}]  ${task.title ?? ''}`.trimEnd());
    console.log(`Owner: ${task.ownerEmail ?? '?'}`);
    console.log('');
    for (const activity of chronological) renderActivity(activity);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

export async function runGetChat(chatId: string, opts: RunGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const [chat, { activities }] = await Promise.all([
      client.getChat(chatId),
      client.getChatActivities(chatId, { limit: 100 }),
    ]);

    if (opts.json) {
      console.log(JSON.stringify({ chat, activities }, null, 2));
      return;
    }

    console.log(`Chat ${chat.id}  [${chat.status}]  ${chat.title ?? ''}`.trimEnd());
    console.log('');
    for (const activity of activities) renderActivity(activity);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

/**
 * agnt run — pull task/chat run detail from the DB via API (no bastion, no log scraping)
 *
 * Usage:
 *   agnt run list [--since 24h] [--account <slug>] [--limit 50] [--profile <name>] [--json]
 *   agnt run task <taskId> [--profile <name>] [--json]
 *   agnt run chat <chatId> [--profile <name>] [--json]
 */

import { resolveProfile } from '../utils/credentials.js';
import { AgntApiClient, type RunSummary } from '../utils/api.js';

const TRUNCATE_LEN = 400;

function truncate(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return '';
  return str.length > TRUNCATE_LEN ? `${str.slice(0, TRUNCATE_LEN)}… (${str.length} chars)` : str;
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

function renderRunSummary(label: string, items: RunSummary[]): void {
  if (!items.length) {
    console.log(`  (none)`);
    return;
  }
  for (const item of items) {
    const account = item.account ? `${item.account.slug}` : 'unknown-account';
    console.log(`  ${item.id}  [${item.status}]  ${account}  ${item.title ?? ''}`.trimEnd());
  }
}

async function clientFor(profile?: string): Promise<AgntApiClient> {
  const { apiUrl, apiKey } = await resolveProfile(profile);
  return new AgntApiClient({ apiUrl, serviceKey: apiKey });
}

export interface RunListOptions {
  since?: string;
  account?: string;
  limit?: string;
  profile?: string;
  json?: boolean;
}

export async function runList(opts: RunListOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const result = await client.listRuns({
      since: opts.since,
      account: opts.account,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Active since ${result.since}`);
    console.log(`\nTasks (${result.tasks.length}):`);
    renderRunSummary('tasks', result.tasks);
    console.log(`\nChats (${result.chats.length}):`);
    renderRunSummary('chats', result.chats);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

export interface RunGetOptions {
  profile?: string;
  json?: boolean;
}

export async function runGetTask(taskId: string, opts: RunGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const run = await client.getTaskRun(taskId);

    if (opts.json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }

    console.log(`Task ${run.task.id}  [${run.task.status}]  ${run.task.title ?? ''}`.trimEnd());
    console.log(`Owner: ${run.task.ownerEmail ?? '?'}  Account: ${run.task.account ?? '?'}`);
    console.log('');
    for (const activity of run.activities) renderActivity(activity);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

export async function runGetChat(chatId: string, opts: RunGetOptions): Promise<void> {
  try {
    const client = await clientFor(opts.profile);
    const run = await client.getChatRun(chatId);

    if (opts.json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }

    console.log(`Chat ${run.chat.id}  [${run.chat.status}]  ${run.chat.title ?? ''}`.trimEnd());
    console.log(`Account: ${run.chat.account ?? '?'}`);
    console.log('');
    for (const activity of run.activities) renderActivity(activity);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

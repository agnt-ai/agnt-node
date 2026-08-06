#!/usr/bin/env node
/**
 * agnt CLI — @agnt-sdk/studio
 */

import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runPull } from './commands/pull.js';
import { runConfigure } from './commands/configure.js';
import { runList, runGetTask, runGetChat } from './commands/run.js';

const program = new Command();

program
  .name('agnt')
  .description('Agnt SDK CLI — manage and run v2 prompt manifests')
  .version('0.0.47');

program
  .command('init')
  .description('Create agnt.config.js in the current directory')
  .action(async () => {
    await runInit();
  });

program
  .command('pull [address]')
  .description(
    'Pull prompt manifest(s) from the Agnt API\n' +
    '  agnt pull skej/contact-collector   # pull one prompt\n' +
    '  agnt pull skej/*                   # pull all public from account'
  )
  .action(async (address?: string) => {
    await runPull(address);
  });

program
  .command('configure')
  .description('Save an API profile to ~/.agnt/credentials (like `aws configure --profile`)')
  .requiredOption('--profile <name>', 'Profile name')
  .requiredOption('--api-url <url>', 'Agnt API base URL')
  .requiredOption('--api-key <key>', 'API key (ak_live_...)')
  .action(async (opts: { profile: string; apiUrl: string; apiKey: string }) => {
    await runConfigure(opts);
  });

const runCmd = program
  .command('run')
  .description('Inspect agent run detail (tasks/chats) via the Agnt API — no bastion, no log scraping');

runCmd
  .command('list')
  .description('List recent tasks/chats (client-side filtered by --since; the API has no server-side time filter)')
  .option('--since <window>', 'Time window, e.g. 24h, 45m, 2d, or an ISO timestamp')
  .option('--status <status>', 'Filter by status (task/chat status value)')
  .option('--limit <n>', 'Max results per collection', '50')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (opts: { since?: string; status?: string; limit: string; profile?: string; json?: boolean }) => {
    await runList(opts);
  });

runCmd
  .command('task <taskId>')
  .description('Fetch the full activity timeline for one task (paginates automatically)')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable transcript')
  .option('--max <n>', 'Max activities to fetch before stopping', '1000')
  .option('--all', 'No cap — fetch every activity, however many pages that takes')
  .action(async (taskId: string, opts: { profile?: string; json?: boolean; max?: string; all?: boolean }) => {
    await runGetTask(taskId, opts);
  });

runCmd
  .command('chat <chatId>')
  .description('Fetch the full activity timeline for one chat (paginates automatically)')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable transcript')
  .option('--max <n>', 'Max activities to fetch before stopping', '1000')
  .option('--all', 'No cap — fetch every activity, however many pages that takes')
  .action(async (chatId: string, opts: { profile?: string; json?: boolean; max?: string; all?: boolean }) => {
    await runGetChat(chatId, opts);
  });

program.parse(process.argv);

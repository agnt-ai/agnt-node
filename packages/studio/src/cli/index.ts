#!/usr/bin/env node
/**
 * agnt CLI — @agnt-sdk/studio
 */

import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runPull } from './commands/pull.js';
import { runConfigure } from './commands/configure.js';
import { runList, runGetTask, runGetChat } from './commands/run.js';
import { evalSummary, evalList, evalGet } from './commands/eval.js';
import {
  runSkillList, runSkillGet, runSkillCreate, runSkillUpdate,
  runSkillPush, runSkillExport, runSkillPublish,
} from './commands/skill.js';

const program = new Command();

program
  .name('agnt')
  .description('Agnt SDK CLI — manage and run v2 prompt manifests')
  .version('0.0.49');

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

const evalCmd = program
  .command('eval')
  .description('Read Run Review evaluations (how runs went, from the user\'s side) — needs an account-level API key');

evalCmd
  .command('summary')
  .description('Averages, outcome and ending buckets, and the by-task-type table')
  .option('--days <n>', 'Window in days', '30')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (opts) => {
    await evalSummary(opts);
  });

evalCmd
  .command('list')
  .description('List evaluations, worst first, with the task and chat each one is about')
  .option('--days <n>', 'Window in days', '30')
  .option('--task-class <class>', 'Only this task type (a row of `agnt eval summary`)')
  .option('--unclassified', 'Only reviews the judge left without a task type')
  .option('--outcome <category>', 'catastrophic | failed | partial | success | unclear')
  .option('--sentiment <ending>', 'pleased | neutral | confused | frustrated | angry | checked_out')
  .option('--min-score <n>', 'Lowest outcome score to include (1-5)')
  .option('--max-score <n>', 'Highest outcome score to include (1-5); --max-score 2 is the problem runs')
  .option('--sort <order>', 'worst (default) or newest')
  .option('--page <n>', 'Page number', '1')
  .option('--limit <n>', 'Reviews per page (max 100)', '25')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable list')
  .action(async (opts) => {
    await evalList(opts);
  });

evalCmd
  .command('get <reviewId>')
  .description('One evaluation in full, with the commands to open its task, chat and trace')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable report')
  .action(async (reviewId, opts) => {
    await evalGet(reviewId, opts);
  });

const skillCmd = program
  .command('skill')
  .description('Create, read, update and publish account skills (including knowledge skills) — needs an API key');

skillCmd
  .command('list')
  .description('List skills in the account')
  .option('--kind <kind>', 'Filter by kind, e.g. knowledge, mcp, cli, agent, workflow')
  .option('--search <text>', 'Search by name, title or description')
  .option('--tier <tier>', 'Filter by tier')
  .option('--category <category>', 'Filter by category')
  .option('--limit <n>', 'Max results', '50')
  .option('--page <n>', 'Page number', '1')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable list')
  .action(async (opts) => {
    await runSkillList(opts);
  });

skillCmd
  .command('get <nameOrId>')
  .description('Show one skill (by slug or id)')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (nameOrId, opts) => {
    await runSkillGet(nameOrId, opts);
  });

skillCmd
  .command('create')
  .description('Create a skill (flat fields — a single-blob knowledge skill by default)')
  .requiredOption('--title <title>', 'Human-readable title')
  .option('--name <slug>', 'Slug (auto-derived from title if omitted)')
  .option('--kind <kind>', 'knowledge (default), mcp, cli, agent, prompt, workflow, task_template', 'knowledge')
  .option('--description <text>', 'Short description')
  .option('--when-to-use <text>', 'Hint for when Prime should reach for this skill')
  .option('--instructions <text>', 'The skill body Prime reads (plain text)')
  .option('--instructions-file <path>', 'Read the skill body from a file instead of --instructions')
  .option('--access <access>', 'private (default) or public')
  .option('--draft', 'Leave status as draft (invisible to Prime) instead of defaulting to active')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (opts) => {
    await runSkillCreate(opts);
  });

skillCmd
  .command('update <nameOrId>')
  .description('Update a skill\'s fields (only what you pass changes)')
  .option('--name <slug>', 'New slug')
  .option('--title <title>', 'New title')
  .option('--description <text>', 'New description')
  .option('--when-to-use <text>', 'New "when to use" hint')
  .option('--instructions <text>', 'New skill body (plain text)')
  .option('--instructions-file <path>', 'Read the new skill body from a file instead of --instructions')
  .option('--kind <kind>', 'New kind')
  .option('--access <access>', 'private or public')
  .option('--status <status>', 'draft, active, or archived')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (nameOrId, opts) => {
    await runSkillUpdate(nameOrId, opts);
  });

skillCmd
  .command('push <file>')
  .description('Create-or-update a skill from a manifest JSON file (the only way to set multi-file content) — round-trips with `agnt skill export`')
  .option('--conflict <strategy>', 'skip | overwrite (default) | merge', 'overwrite')
  .option('--draft', 'Leave status as draft (invisible to Prime) instead of defaulting to active')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (file, opts) => {
    await runSkillPush(file, opts);
  });

skillCmd
  .command('export <nameOrId>')
  .description('Export a skill as a portable manifest JSON (prints to stdout, or use -o to save)')
  .option('-o, --output <path>', 'Write to a file instead of stdout')
  .option('--profile <name>', 'Credentials profile to use')
  .action(async (nameOrId, opts) => {
    await runSkillExport(nameOrId, opts);
  });

skillCmd
  .command('publish <nameOrId>')
  .description('Publish a skill: snapshot a version and deploy it to an environment')
  .requiredOption('--environment <slug>', 'Environment slug to publish into (e.g. dev, live)')
  .option('--deploy', 'Also mark the environment deployment active (not just version-snapshot)')
  .option('--note <text>', 'Publish note')
  .option('--profile <name>', 'Credentials profile to use')
  .option('--json', 'Print raw JSON instead of a human-readable summary')
  .action(async (nameOrId, opts) => {
    await runSkillPublish(nameOrId, opts);
  });

program.parse(process.argv);

#!/usr/bin/env node
/**
 * agnt CLI — @agnt-sdk/studio
 */

import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runPull } from './commands/pull.js';

const program = new Command();

program
  .name('agnt')
  .description('Agnt SDK CLI — manage and run v2 prompt manifests')
  .version('0.0.1');

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

program.parse(process.argv);

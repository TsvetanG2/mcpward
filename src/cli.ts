#!/usr/bin/env node

import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from './config/load.js';
import { initCommand } from './commands/init.js';
import { runCommand, type RunOptions } from './commands/run.js';
import { baselineCommand, type BaselineOptions } from './commands/baseline.js';
import { diffCommand, type DiffOptions } from './commands/diff.js';

interface GlobalOptions {
  config: string;
  reporter: string;
  out?: string;
  json?: boolean;
  verbose?: boolean;
}

const program = new Command();

program
  .name('mcpward')
  .description(
    'Black-box security & contract testing for MCP servers — catch rug-pulls, tool poisoning, and schema drift before your agents do.'
  )
  .version('0.1.0');

// Global options
program
  .option('-c, --config <path>', 'Path to config file', 'mcpward.yaml')
  .option(
    '-r, --reporter <type>',
    'Reporter type: console, json, junit, sarif',
    'console'
  )
  .option('-o, --out <path>', 'Output file path for reporters')
  .option('--json', 'Shorthand for --reporter json')
  .option('-v, --verbose', 'Verbose output');

// init command
program
  .command('init')
  .description('Scaffold a new mcpward.yaml configuration file')
  .action(async () => {
    try {
      await initCommand();
    } catch (err) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(2);
    }
  });

// run command
program
  .command('run')
  .description('Run all configured checks against the MCP server')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    try {
      const config = await loadConfig(opts.config);
      const exitCode = await runCommand(config, opts as RunOptions);
      process.exit(exitCode);
    } catch (err) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(2);
    }
  });

// baseline command
program
  .command('baseline')
  .description('Capture current server surface to lockfile')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    try {
      const config = await loadConfig(opts.config);
      await baselineCommand(config, opts as BaselineOptions);
    } catch (err) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(2);
    }
  });

// diff command
program
  .command('diff')
  .description('Show drift between current server and baseline')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    try {
      const config = await loadConfig(opts.config);
      const exitCode = await diffCommand(config, opts as DiffOptions);
      process.exit(exitCode);
    } catch (err) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : err);
      process.exit(2);
    }
  });

program.parse();

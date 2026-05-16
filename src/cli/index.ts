#!/usr/bin/env node

/**
 * xabot CLI entry point.
 *
 * Usage:
 *   npx xabot <platform> [platform-options] <action> [action-options]
 *
 * Platforms:
 *   feishu    Feishu (Lark) platform commands
 */

import { Command } from 'commander';
import { registerFeishu } from './feishu.js';

const program = new Command();

program
  .name('xabot')
  .description(`xabot — bot bridge CLI

Platform subcommands:
  feishu    Feishu (Lark) platform commands`)
  .addHelpText(
    'after',
    `Examples:
  xabot feishu --app-id cli --app-secret secret listen --chat-id xxx
  xabot feishu --app-id cli --app-secret secret send och_xxx "Hello!"
  xabot feishu --app-id cli --app-secret secret health
  xabot feishu --app-id cli --app-secret secret run
  xabot feishu --app-id cli --app-secret secret chat`,
  );

registerFeishu(program);

program.parseAsync(process.argv).then(
  () => process.exit(0),
  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`❌ ${msg}\n`);
    process.exit(1);
  },
);

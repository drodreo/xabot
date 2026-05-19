#!/usr/bin/env node

/**
 * xabot CLI entry point.
 *
 * Usage:
 *   npx xabot <platform> [platform-options] <action> [action-options]
 *
 * Platforms:
 *   feishu    Feishu (Lark) platform commands
 *   wechat    WeChat (iLink Bot) platform commands
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { registerFeishu } from './feishu.js';
import { registerWechat } from './wechat.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('xabot');

const program = new Command();
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
program.version(pkg.version);

program
  .name('xabot')
  .description(`xabot — bot bridge CLI

Platform subcommands:
  feishu    Feishu (Lark) platform commands
  wechat    WeChat (iLink Bot) platform commands`)
  .addHelpText(
    'after',
    `Examples:
  xabot feishu --app-id cli --app-secret secret health
  xabot feishu --app-id cli --app-secret secret run
  xabot feishu --app-id cli --app-secret secret chat

  xabot wechat health --token ilinkbot_xxx
  xabot wechat run
  xabot wechat chat`,
  );

registerFeishu(program);
registerWechat(program);

program.parseAsync(process.argv).then(
  () => process.exit(0),
  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('fatal: %s', msg);
    process.exit(1);
  },
);

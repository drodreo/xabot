#!/usr/bin/env node

/**
 * xabot CLI entry point.
 *
 * Usage:
 *   npx xabot <subcommand> [flags]
 *
 * Subcommands:
 *   discover  — Obtain a chatId via pairing-code flow
 *   listen    — Listen for incoming cloud messages and print to stdout
 *   send      — Send a text message to a specified chatId
 *   health    — Verify credentials and connection health
 *   run       — Start Bridge mode (cloud ↔ ACP bidirectional loop)
 */

import { Command, InvalidArgumentError, Option } from 'commander';
import { FeishuClient } from '../platforms/feishu/client.js';
import { WechatClient } from '../platforms/wechat/client.js';
import type { PlatformClient } from '../core/client.js';
import { discover } from './discover.js';
import { listen } from './listen.js';
import { send } from './send.js';
import { health } from './health.js';
import { run } from './run.js';
import { AcpSession } from '../acp/session.js';
import { Router } from '../core/router.js';
import { agentId, channelId } from '../core/types.js';

// ---------------------------------------------------------------------------
// Platform client factory
// ---------------------------------------------------------------------------

function createClient(platform: 'feishu' | 'wechat', appId: string, appSecret: string, logLevel?: string): PlatformClient {
  switch (platform) {
    case 'feishu': {
      const cfg: { appId: string; appSecret: string; logLevel?: 'info' | 'debug' | 'trace' } = { appId, appSecret };
      if (logLevel) cfg.logLevel = logLevel as 'info' | 'debug' | 'trace';
      return new FeishuClient(cfg);
    }
    case 'wechat':
      return new WechatClient({ appId, appSecret });
  }
}

// ---------------------------------------------------------------------------
// Global option definitions (added to every subcommand)
// ---------------------------------------------------------------------------

function platformOption(cmd: Command): Command {
  return cmd.addOption(
    new Option('--platform <platform>', 'Platform')
      .makeOptionMandatory(true)
      .argParser((val: string) => {
        if (!['feishu', 'wechat'].includes(val)) {
          throw new InvalidArgumentError("Must be 'feishu' or 'wechat'");
        }
        return val as 'feishu' | 'wechat';
      }),
  );
}

function appIdOption(cmd: Command): Command {
  return cmd.addOption(new Option('--app-id <id>', 'App ID').makeOptionMandatory(true));
}

function appSecretOption(cmd: Command): Command {
  return cmd.addOption(new Option('--app-secret <secret>', 'App Secret').makeOptionMandatory(true));
}

function logLevelOption(cmd: Command): Command {
  return cmd.addOption(
    new Option('--log-level <level>', 'Log level')
      .choices(['info', 'debug', 'trace'])
      .default('info'),
  );
}

function addGlobalOptions(cmd: Command): Command {
  return platformOption(appIdOption(appSecretOption(logLevelOption(cmd))));
}

// ---------------------------------------------------------------------------
// Build program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('xabot')
  .description(`xabot — bot bridge CLI

Subcommands:
  discover  Obtain a chatId via pairing-code flow
  listen    Listen for incoming messages and print to stdout
  send      Send a text message to a specified chatId
  health    Verify credentials and connection health
  run       Start Bridge mode with SIGINT/SIGTERM graceful shutdown`)
  .addHelpText(
    'after',
    `Examples:
  xabot discover --platform feishu --app-id cli --app-secret secret
  xabot listen   --platform feishu --app-id cli --app-secret secret
  xabot send     --platform wechat --app-id cli --app-secret secret och_xxx "Hello!"
  xabot health   --platform feishu --app-id cli --app-secret secret
  xabot run      --platform feishu --app-id cli --app-secret secret --agent-id agent1 --chat-ids och_1,och_2`,
  );

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

addGlobalOptions(program.command('discover'))
  .option('--timeout-ms <ms>', 'Timeout in milliseconds', '60000')
  .description('Obtain a chatId via pairing-code flow')
  .action(async (options: Record<string, unknown>) => {
    const client = createClient(
      options.platform as 'feishu' | 'wechat',
      options.appId as string,
      options.appSecret as string,
      options.logLevel as string | undefined,
    );
    await client.connect();
    await discover(client, { timeoutMs: Number(options.timeoutMs) });
  });

// ---------------------------------------------------------------------------
// listen
// ---------------------------------------------------------------------------

addGlobalOptions(program.command('listen'))
  .requiredOption('--chat-id <id>', 'Chat ID for bidirectional messaging')
  .description('Interactive debug: relay stdin to chatId, print incoming messages to stderr')
  .action(async (options: Record<string, unknown>) => {
    const client = createClient(
      options.platform as 'feishu' | 'wechat',
      options.appId as string,
      options.appSecret as string,
      options.logLevel as string | undefined,
    );
    await client.connect();
    await listen(client, { chatId: channelId(options.chatId as string) });
  });

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

addGlobalOptions(program.command('send'))
  .argument('<chatId>', 'Target chat ID')
  .argument('<message...>', 'Message text')
  .description('Send a text message to the specified chatId')
  .action(async (chatId: string, message: string[], options: Record<string, unknown>) => {
    const client = createClient(
      options.platform as 'feishu' | 'wechat',
      options.appId as string,
      options.appSecret as string,
      options.logLevel as string | undefined,
    );
    await client.connect();
    await send(client, message.join(' '), { chatId: channelId(chatId) });
    await client.close();
  });

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

addGlobalOptions(program.command('health'))
  .description('Verify credentials and connection health')
  .action(async (options: Record<string, unknown>) => {
    const client = createClient(
      options.platform as 'feishu' | 'wechat',
      options.appId as string,
      options.appSecret as string,
      options.logLevel as string | undefined,
    );
    await client.connect();
    await health(client);
    await client.close();
  });

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

addGlobalOptions(program.command('run'))
  .requiredOption('--agent-id <id>', 'Agent ID')
  .requiredOption('--chat-ids <ids>', 'Comma-separated chat IDs')
  .description('Start Bridge mode with SIGINT/SIGTERM graceful shutdown')
  .action(async (options: Record<string, unknown>) => {
    const cloud = createClient(
      options.platform as 'feishu' | 'wechat',
      options.appId as string,
      options.appSecret as string,
      options.logLevel as string | undefined,
    );
    await cloud.connect();
    const acp = await AcpSession.connect();
    const router = new Router();
    await run(cloud, acp, router, {
      agentId: agentId(options.agentId as string),
      chatIds: (options.chatIds as string).split(',').map(channelId),
    });
  });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).then(
  () => process.exit(0),
  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`❌ ${msg}\n`);
    process.exit(1);
  },
);

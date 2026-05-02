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

import { parseDiscoverArgs, parseAcpArgs } from '../config/schema.js';
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
// Shared platform-flag parsers
// ---------------------------------------------------------------------------

interface PlatformFlags {
  platform: 'feishu' | 'wechat';
  appId: string;
  appSecret: string;
}

function parsePlatformFlags(argv: string[]): PlatformFlags {
  let platform: string | undefined;
  let appId: string | undefined;
  let appSecret: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--platform') {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith('--')) throw new Error('--platform requires a value');
      platform = argv[i + 1]; i += 2;
    } else if (arg === '--app-id') {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith('--')) throw new Error('--app-id requires a value');
      appId = argv[i + 1]; i += 2;
    } else if (arg === '--app-secret') {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith('--')) throw new Error('--app-secret requires a value');
      appSecret = argv[i + 1]; i += 2;
    } else {
      i++;
    }
  }

  if (!platform || !appId || !appSecret) {
    throw new Error('Missing required flags: --platform, --app-id, --app-secret');
  }
  return { platform: platform as 'feishu' | 'wechat', appId, appSecret };
}

// ---------------------------------------------------------------------------
// Subcommand parsers
// ---------------------------------------------------------------------------

interface ListenFlags extends PlatformFlags {}

function parseListenArgs(argv: string[]): ListenFlags {
  return parsePlatformFlags(argv) as ListenFlags;
}

interface SendFlags extends PlatformFlags {
  chatId: string;
  message: string;
}

function parseSendArgs(argv: string[]): SendFlags {
  const flags = parsePlatformFlags(argv);

  // Remaining non-flag positional args: first = chatId, rest = message
  const remaining: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (
      arg === '--platform' ||
      arg === '--app-id' ||
      arg === '--app-secret'
    ) {
      i += 2; // skip flag and its value
    } else {
      remaining.push(arg as string);
      i++;
    }
  }

  const chatId = remaining[0]!;
  const message = remaining.slice(1).join(' ');
  if (!chatId) {
    throw new Error(
      'Usage: xabot send --platform <p> --app-id <id> --app-secret <s> <chatId> <message...>',
    );
  }
  return { ...flags, chatId, message };
}

interface HealthFlags extends PlatformFlags {}

function parseHealthArgs(argv: string[]): HealthFlags {
  return parsePlatformFlags(argv) as HealthFlags;
}
// ---------------------------------------------------------------------------
// Platform client factory
// ---------------------------------------------------------------------------

function createClient(flags: PlatformFlags): PlatformClient {
  switch (flags.platform) {
    case 'feishu':
      return new FeishuClient({ appId: flags.appId, appSecret: flags.appSecret });
    case 'wechat':
      return new WechatClient({ appId: flags.appId, appSecret: flags.appSecret });
  }
}

// ---------------------------------------------------------------------------
// Subcommand router
// ---------------------------------------------------------------------------

const subcommand = process.argv[2] ?? 'help';
const subcommandArgv = process.argv.slice(3);

async function main() {
  switch (subcommand) {
    case 'discover': {
      const flags = parseDiscoverArgs(subcommandArgv);
      const client = createClient(flags);
      await client.connect();
      await discover(client, { timeoutMs: flags.timeoutMs });
      break;
    }

    case 'listen': {
      const flags = parseListenArgs(subcommandArgv);
      const client = createClient(flags);
      await client.connect();
      await listen(client);
      break;
    }

    case 'send': {
      const flags = parseSendArgs(subcommandArgv);
      const client = createClient(flags);
      await client.connect();
      await send(client, flags.message, { chatId: channelId(flags.chatId) });
      await client.close();
      break;
    }

    case 'health': {
      const flags = parseHealthArgs(subcommandArgv);
      const client = createClient(flags);
      await client.connect();
      await health(client);
      await client.close();
      break;
    }

    case 'run': {
      const flags = parseAcpArgs(subcommandArgv);
      const cloud = createClient(flags);
      await cloud.connect();
      const acp = await AcpSession.connect();
      const router = new Router();
      await run(cloud, acp, router, {
        agentId: agentId(flags.agentId),
        chatIds: flags.chatIds.map(channelId),
      });
      break;
    }

    case 'help':
    default:
      process.stdout.write(
        `xabot — bot bridge CLI

Usage: xabot <subcommand> [flags]

Subcommands:
  discover  --platform <p> --app-id <id> --app-secret <s> [--timeout-ms <ms>]
              Obtain a chatId via pairing-code flow.
  listen    --platform <p> --app-id <id> --app-secret <s>
              Listen for incoming messages and print to stdout.
  send      --platform <p> --app-id <id> --app-secret <s> <chatId> <message...>
              Send a text message to the specified chatId.
  health    --platform <p> --app-id <id> --app-secret <s>
              Verify credentials and connection health.
  run       --platform <p> --app-id <id> --app-secret <s> --agent-id <aid> --chat-ids <ids>
              Start Bridge mode with SIGINT/SIGTERM graceful shutdown.

Examples:
  xabot discover --platform feishu --app-id cli --app-secret secret
  xabot listen   --platform feishu --app-id cli --app-secret secret
  xabot send     --platform wechat --app-id cli --app-secret secret och_xxx "Hello!"
  xabot health   --platform feishu --app-id cli --app-secret secret
  xabot run      --platform feishu --app-id cli --app-secret secret --agent-id agent1 --chat-ids och_1,och_2
`,
      );
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
});

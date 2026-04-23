import { z } from 'zod';

/** CLI arguments for the `acp` subcommand — all config passed at startup, nothing persisted. */
export const AcpArgsSchema = z.object({
  platform: z.enum(['feishu', 'wechat']),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  agentId: z.string().min(1),
  chatIds: z.array(z.string().min(1)).min(1),
});

export type AcpArgs = z.infer<typeof AcpArgsSchema>;

export function parseAcpArgs(argv: string[]): AcpArgs {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--platform': args.platform = next; i++; break;
      case '--app-id': args.appId = next; i++; break;
      case '--app-secret': args.appSecret = next; i++; break;
      case '--agent-id': args.agentId = next; i++; break;
      case '--chat-ids': args.chatIds = (next ?? '').split(','); i++; break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return AcpArgsSchema.parse(args);
}

/** CLI arguments for the `discover` subcommand — obtains chatId via pairing-code flow. */
export const DiscoverArgsSchema = z.object({
  platform: z.enum(['feishu', 'wechat']),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  timeoutMs: z.number().default(60000),
});

export type DiscoverArgs = z.infer<typeof DiscoverArgsSchema>;

export function parseDiscoverArgs(argv: string[]): DiscoverArgs {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--platform': args.platform = next; i++; break;
      case '--app-id': args.appId = next; i++; break;
      case '--app-secret': args.appSecret = next; i++; break;
      case '--timeout-ms': {
        const ms = Number(next);
        if (ms !== ms || ms < 0) {
          throw new Error('--timeout-ms must be a non-negative number');
        }
        args.timeoutMs = ms;
        i++;
        break;
      }
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return DiscoverArgsSchema.parse(args);
}

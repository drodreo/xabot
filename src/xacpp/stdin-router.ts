import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * Routes stdin input to named channels.
 *
 * By default, input goes to the 'default' channel.
 * `intercept()` switches routing to 'cmd_response' (e.g. for action/question replies).
 * `release()` switches back to 'default'.
 *
 * Unregistered channels silently drop input.
 */
export class StdinRouter {
  private readonly subscribers = new Map<string, (input: string) => void>();
  private currentChannel = 'default';
  private rl: ReturnType<typeof createInterface> | null = null;
  private readonly stdin: Readable;

  constructor(stdin: Readable) {
    this.stdin = stdin;
  }

  subscribe(channel: 'default' | 'cmd_response', fn: (input: string) => void | Promise<void>): void {
    this.subscribers.set(channel, fn);
  }

  intercept(): void {
    this.currentChannel = 'cmd_response';
  }

  release(): void {
    this.currentChannel = 'default';
  }

  async start(): Promise<void> {
    if (this.rl) {
      throw new Error('StdinRouter already started');
    }
    this.rl = createInterface({ input: this.stdin });
    for await (const line of this.rl) {
      const text = line.trim();
      const handler = this.subscribers.get(this.currentChannel);
      if (handler) {
        await handler(text);
      }
    }
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }
}

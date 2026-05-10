/**
 * listen CLI subcommand.
 *
 * Interactive debug tool:
 *   - Prints every incoming cloud message to stderr.
 *   - Reads lines from stdin and sends them as text to a fixed chatId.
 *
 * Meant for debugging — have a live conversation with a cloud chat
 * without needing ACP / agent infrastructure.
 */

import type { PlatformClient } from '../core/client.js';
import type { ChannelId, Message } from '../core/types.js';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** Formatters must be synchronous — returns a display string for a message. */
export type MessageFormatter = (msg: Message) => string;

const DEFAULT_FORMATTER: MessageFormatter = (msg) => {
  const dir = msg.direction === 'incoming' ? '⬇' : '⬆';
  const text = msg.content.type === 'text'
    ? msg.content.text
    : `[${msg.content.type}]`;
  return `${dir} [${msg.chatId}] ${text}`;
};

export interface ListenOptions {
  /** Target chatId — every line read from stdin is sent to this chat. */
  chatId: ChannelId;
  /**
   * Stderr writer — used for incoming messages and prompts.
   * Defaults to process.stderr.write when omitted.
   */
  stderr?: (chunk: string) => void;
  /** Custom message formatter. */
  formatter?: MessageFormatter;
  /**
   * Override stdin source — intended for testing.
   * When omitted, uses process.stdin.
   */
  stdin?: Readable;
}

/**
 * Listen for incoming messages and optionally relay stdin lines to a chatId.
 *
 * Two concurrent loops:
 *   1. Cloud → stderr: prints every incoming message.
 *   2. Stdin → cloud: reads lines and sends them to the configured chatId.
 *
 * Both loops stop when the cloud message stream ends or stdin closes.
 *
 * @param client   - A connected PlatformClient.
 * @param options  - chatId, stderr writer, stdin, and optional formatter injection.
 */
export async function listen(
  client: PlatformClient,
  options: ListenOptions,
): Promise<void> {
  const {
    chatId,
    stderr = (chunk: string) => process.stderr.write(chunk),
    formatter = DEFAULT_FORMATTER,
    stdin = process.stdin,
  } = options;

  const tasks: Promise<void>[] = [];

  // Task 1: Cloud → stderr
  tasks.push((async () => {
    for await (const msg of client.messages()) {
      stderr(formatter(msg) + '\n');
    }
  })());

  // Task 2: Stdin → cloud
  stderr('输入消息并回车发送（Ctrl+C 退出）\n');
  tasks.push((async () => {
    const rl = createInterface({ input: stdin as NodeJS.ReadableStream });
    try {
      for await (const line of rl) {
        const text = line.trim();
        if (!text) continue;
        try {
          await client.send(chatId, { type: 'text', text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stderr(`发送失败: ${msg}\n`);
        }
      }
    } finally {
      rl.close();
    }
  })());

  // Both tasks run concurrently; resolve when either one finishes.
  await Promise.race(tasks);
}

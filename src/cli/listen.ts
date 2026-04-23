/**
 * listen CLI subcommand.
 *
 * Connects to the cloud platform and prints every incoming message to stdout.
 * Meant for debugging — see what the bot is actually receiving.
 */

import type { PlatformClient } from '../core/client.js';
import type { Message } from '../core/types.js';

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
  /** Output writer — defaults to process.stdout.write. */
  writer?: (chunk: string) => void;
  /** Custom message formatter. */
  formatter?: MessageFormatter;
}

/**
 * Listen for incoming messages and write them to the provided writer.
 *
 * @param client   - A connected PlatformClient.
 * @param options  - writer and optional formatter injection.
 */
export async function listen(
  client: PlatformClient,
  options: ListenOptions = {},
): Promise<void> {
  const { writer = (chunk: string) => process.stdout.write(chunk), formatter = DEFAULT_FORMATTER } = options;

  for await (const msg of client.messages()) {
    writer(formatter(msg) + '\n');
  }
}

/**
 * send CLI subcommand.
 *
 * Reads a text message and a target chatId, then sends the message
 * via the provided PlatformClient.
 */

import type { PlatformClient } from '../core/client.js';
import type { ChannelId, MessageId, MessageContent } from '../core/types.js';

export interface SendOptions {
  chatId: ChannelId;
  /** Output writer — defaults to process.stdout.write. */
  writer?: (chunk: string) => void;
}

/**
 * Send a text message to the specified chatId via the given client.
 *
 * @param client     - A connected PlatformClient.
 * @param text       - The message text to send.
 * @param options    - Target chatId and optional writer injection.
 * @returns The sent message ID.
 */
export async function send(
  client: PlatformClient,
  text: string,
  options: SendOptions,
): Promise<MessageId> {
  const { chatId, writer = (chunk: string) => process.stdout.write(chunk) } = options;

  const content: MessageContent = { type: 'text', text };
  const msgId = await client.send(chatId, content);
  writer(`已发送消息至 ${chatId}，msgId: ${msgId}\n`);
  return msgId;
}

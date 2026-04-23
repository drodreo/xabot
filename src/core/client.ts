import type {
  Message,
  MessageId,
  ChannelId,
  StreamCapability,
  MessageContent,
} from './types.js';

/** Platform client interface — all cloud platforms implement this. */
export interface PlatformClient {
  readonly platform: string;
  connect(): Promise<void>;
  send(chatId: ChannelId, content: MessageContent): Promise<MessageId>;
  /**
   * Streaming send — caller invokes this repeatedly to deliver chunks.
   * Semantic convention:
   * - Return `Promise<MessageId>` on the last chunk call to report completion.
   * - Return `void` when the stream is already complete (no further chunks follow).
   */
  sendChunk?(chatId: ChannelId, content: MessageContent): Promise<MessageId>;
  messages(): AsyncIterable<Message>;
  streamCapability(): StreamCapability;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

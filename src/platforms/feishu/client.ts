import {
  Client,
  WSClient,
  EventDispatcher,
  Domain,
} from '@larksuiteoapi/node-sdk';

import type { PlatformClient } from '../../core/client.js';
import type { ChannelId, MessageId, Message, MessageContent } from '../../core/types.js';
import { StreamCapability, channelId, messageId, userId } from '../../core/types.js';
import { XabotError } from '../../core/error.js';
import { toStandardMessage, fromMessageContent, type FeishuMessageEvent } from './message.js';

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
}

/**
 * Feishu platform client using WebSocket long connection.
 *
 * Uses @larksuiteoapi/node-sdk:
 * - WSClient: receives incoming messages via WebSocket
 * - Client: sends outgoing messages via REST API
 */
export class FeishuClient implements PlatformClient {
  readonly platform = 'feishu' as const;

  private readonly config: FeishuClientConfig;
  private readonly wsClient: WSClient;
  private readonly httpClient: Client;
  private readonly eventDispatcher: EventDispatcher;
  private readonly messageBuffer: FeishuMessageEvent[] = [];
  private messageResolve: ((msg: FeishuMessageEvent) => void) | null = null;
  private connected = false;
  readonly #abortCtrl = new AbortController();

  constructor(config: FeishuClientConfig) {
    this.config = config;

    this.wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Domain.Feishu,
    });

    this.httpClient = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Domain.Feishu,
    });

    this.eventDispatcher = new EventDispatcher({});

    // Register the message receive handler — push events into a queue
    // that messages() async generator will consume.
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        // If a reader is waiting, resolve immediately; otherwise buffer.
        if (this.messageResolve) {
          const resolve = this.messageResolve;
          this.messageResolve = null;
          resolve(data);
        } else {
          this.messageBuffer.push(data);
        }
      },
    });
  }

  // --------------------------------------------------------------------------
  // PlatformClient implementation
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.connected = true;
    // Resolve any iterator that was waiting before the connection was established.
    // Pass a valid empty event so toStandardMessage() doesn't crash on undefined.
    if (this.messageResolve) {
      this.messageResolve({
        sender: { sender_type: '' },
        message: { message_id: '', chat_id: '', create_time: '', chat_type: '', message_type: '', content: '' },
      });
      this.messageResolve = null;
    }
  }

  async send(chatId: ChannelId, content: MessageContent): Promise<MessageId> {
    const body = fromMessageContent(chatId, content);
    const result = await this.httpClient.im.message.create({
      data: {
        receive_id: body.receive_id,
        msg_type: body.msg_type,
        content: body.content,
      },
      params: {
        receive_id_type: 'chat_id',
      },
    });

    if (result.code !== 0) {
      throw XabotError.platform(`Feishu API error: code=${result.code}, msg=${result.msg}`);
    }

    if (!result.data?.message_id) {
      throw XabotError.platform('Feishu send failed: no message_id returned');
    }
    return messageId(result.data.message_id);
  }

  messages(): AsyncIterable<Message> {
    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async (): Promise<IteratorResult<Message>> => {
            // If the connection was closed, stop the iterator.
            if (this.#abortCtrl.signal.aborted) {
              return { done: true, value: undefined };
            }

            // Wait for the next incoming Feishu event.
            // If the buffer has events, consume them first (FIFO).
            let event: FeishuMessageEvent | undefined = this.messageBuffer.shift();

            if (!event) {
              event = await new Promise<FeishuMessageEvent>((resolve) => {
                this.messageResolve = resolve;
              });
            }

            // If the abort signal fired while we were waiting, stop.
            if (this.#abortCtrl.signal.aborted) {
              return { done: true, value: undefined };
            }

            return { done: false, value: toStandardMessage(event) };
          },
        };
      },
    };
  }

  streamCapability(): StreamCapability {
    return StreamCapability.NonStreaming;
  }

  async healthCheck(): Promise<void> {
    if (!this.connected) {
      throw XabotError.platform('FeishuClient not connected');
    }
    // WSClient doesn't expose a direct health check API.
    // We consider the connection healthy if connect() succeeded
    // and close() hasn't been called.
  }

  async close(): Promise<void> {
    // Abort first so that any iterator polling abortCtrl sees the signal
    // before messageResolve is cleared, preventing a race where an iterator
    // sets messageResolve after the loop but before abort is called.
    this.#abortCtrl.abort();
    // Resolve all pending iterators so they exit cleanly instead of hanging.
    while (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve({
        sender: { sender_type: '' },
        message: { message_id: '', chat_id: '', create_time: '', chat_type: '', message_type: '', content: '' },
      });
    }
    await this.wsClient.close({});
    this.connected = false;
  }
}

import {
  Client,
  WSClient,
  EventDispatcher,
  Domain,
  LoggerLevel,
} from '@larksuiteoapi/node-sdk';

import type { PlatformClient } from '../../core/client.js';
import type { ChannelId, MessageId, UserId, Message, MessageContent } from '../../core/types.js';
import type { FileRef } from 'xacpp';
import { StreamCapability, channelId, messageId, userId } from '../../core/types.js';
import { XabotError } from '../../core/error.js';
import { toStandardMessage, fromMessageContent, type FeishuMessageEvent } from './message.js';
import { uploadImage, uploadFile, downloadMessageResource } from './upload.js';
import { saveTemp } from '../../core/fs-utils.js';
import { createLogger } from '../../core/logger.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const log = createLogger('FeishuClient');

export type LogLevel = 'info' | 'debug' | 'trace';

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  logLevel?: LogLevel;
}

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

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
  private readonly activeReactions = new Map<string /*messageId*/, string /*reactionId*/>();

  constructor(config: FeishuClientConfig) {
    this.config = config;

    const level = config.logLevel ?? DEFAULT_LOG_LEVEL;
    const sdkLevel =
      level === 'trace' ? LoggerLevel.trace : level === 'debug' ? LoggerLevel.debug : LoggerLevel.info;

    // Conditionally add loggerLevel – the SDK types use exactOptionalPropertyTypes
    // which rejects implicit undefined, so we build the options object in two steps.
    const wsBase = { appId: config.appId, appSecret: config.appSecret, domain: Domain.Feishu };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.wsClient = new WSClient({
      ...wsBase,
      loggerLevel: sdkLevel,
      onReady: () => { log.info('WSClient onReady: ws connected'); },
      onError: (err: unknown) => { log.error('WSClient onError: %s', err instanceof Error ? err.message : String(err)); },
      onReconnecting: () => { log.warn('WSClient onReconnecting'); },
      onReconnected: () => { log.info('WSClient onReconnected'); },
    } as any);

    const httpBase = { appId: config.appId, appSecret: config.appSecret, domain: Domain.Feishu };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.httpClient = new Client({ ...httpBase, loggerLevel: sdkLevel }) as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.eventDispatcher = new EventDispatcher({ loggerLevel: sdkLevel }) as any;

    // Register the message receive handler — push events into a queue
    // that messages() async generator will consume.
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        log.debug('im.message.receive_v1 received');
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
    if (content.type === 'text') {
      return this._doSend(fromMessageContent(chatId, content));
    }

    const src = content.source;

    if (src.localUri) {
      try {
        return await this._uploadAndSend(chatId, content, src.localUri);
      } catch (err) {
        log.warn('upload failed (localUri), fallback to text: %s', err);
        return this._doSend(fromMessageContent(chatId, { type: 'text', text: `[${content.type}]` }));
      }
    }

    log.warn('send: %s has no localUri, sending placeholder', content.type);
    return this._doSend(fromMessageContent(chatId, { type: 'text', text: `[${content.type} 无法发送]` }));
  }

  private async _uploadAndSend(
    chatId: ChannelId,
    content: Extract<MessageContent, { source: FileRef }>,
    filePath: string,
  ): Promise<MessageId> {
    if (content.type === 'image') {
      const key = await uploadImage(this.httpClient, filePath);
      const effective: MessageContent = { ...content, source: { ...content.source, remoteUrl: key } };
      return this._doSend(fromMessageContent(chatId, effective));
    }

    const result = await uploadFile(this.httpClient, filePath, content.source.mimeType, content.type === 'file' ? content.name : undefined);
    const effective: MessageContent = { ...content, source: { ...content.source, remoteUrl: result.key } };
    if (effective.type === 'file' && effective.name === undefined) {
      effective.name = result.name;
    }
    return this._doSend(fromMessageContent(chatId, effective));
  }

  private async _doSend(body: import('./message.js').FeishuMessageBody): Promise<MessageId> {
    const result = await this.httpClient.im.message.create({
      data: {
        receive_id: body.receive_id,
        msg_type: body.msg_type,
        content: body.content,
      },
      params: { receive_id_type: 'chat_id' },
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

            const msg = toStandardMessage(event);
            const content = msg.content;
            if (content.type !== 'text' && content.source && !content.source.localUri) {
              if (content.source.remoteUrl) {
                const tmpPath = `${tmpdir()}/xabot_${randomUUID()}_${content.source.remoteUrl.replace(/\W/g, '_').slice(0, 40)}`;
                try {
                  const resourceType = content.type === 'image' ? 'image' : 'file';
                  await downloadMessageResource(this.httpClient, msg.id as string, content.source.remoteUrl, resourceType, tmpPath);
                  const fileNameHint = content.type === 'file' ? content.name : undefined;
                  const meta = await saveTemp(tmpPath, fileNameHint);
                  if (!meta.mimeType) {
                    throw new Error(`${content.type}接收失败：无法识别文件类型`);
                  }
                  const enrichedSource = {
                    ...content.source,
                    localUri: meta.localUri,
                    sha256: meta.sha256,
                    sizeBytes: meta.sizeBytes,
                    mimeType: meta.mimeType,
                    requireOrganized: true,
                  };
                  msg.content = { ...content, source: enrichedSource };
                } catch (err) {
                  const reason = err instanceof Error ? err.message : String(err);
                  log.warn('download media failed: %s', reason);
                  msg.content = { type: 'text', text: `[${content.type}接收失败：${reason}]` };
                  msg.fallback = true;
                }
              } else {
                log.warn('media has no remoteUrl: type=%s', content.type);
                msg.content = { type: 'text', text: `[${content.type}接收失败：缺少下载地址]` };
                msg.fallback = true;
              }
            }

            return { done: false, value: msg };
          },
        };
      },
    };
  }

  streamCapability(): StreamCapability {
    return StreamCapability.NonStreaming;
  }

  /**
   * Fetch a fresh tenant_access_token from Feishu.
   */
  private async fetchTenantToken(): Promise<string> {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw XabotError.platform(`Feishu auth failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (json.code !== 0 || !json.tenant_access_token) {
      throw XabotError.platform(`Feishu auth failed: code=${json.code}, msg=${json.msg}`);
    }
    return json.tenant_access_token;
  }

  /**
   * List subscribed event types by calling the event subscription list API.
   */
  async listEventSubscriptions(): Promise<string[]> {
    const token = await this.fetchTenantToken();
    const res = await fetch('https://open.feishu.cn/open-apis/event/v1/app/event_subscription', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw XabotError.platform(`Feishu event subscription list failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as { code?: number; msg?: string; data?: { events?: string[] } };
    if (json.code !== 0) {
      throw XabotError.platform(`Feishu event subscription list failed: code=${json.code}, msg=${json.msg}`);
    }

    return json.data?.events ?? [];
  }

  async healthCheck(): Promise<void> {
    if (!this.connected) {
      throw XabotError.platform('FeishuClient not connected');
    }
    // Verify credentials + API reachability by fetching a fresh tenant token.
    await this.fetchTenantToken();
  }

  async setTypingIndicator(_chatId: ChannelId, _senderId: UserId, messageId?: MessageId): Promise<void> {
    if (!messageId) return;
    const result = await this.httpClient.im.messageReaction.create({
      path: { message_id: messageId as string },
      data: { reaction_type: { emoji_type: 'Typing' } },
    });
    if (result?.data?.reaction_id) {
      this.activeReactions.set(messageId as string, result.data.reaction_id);
    }
  }

  async refreshTypingIndicator(_chatId: ChannelId, _senderId: UserId): Promise<void> {
    // Feishu does not require refresh — the server maintains reactions automatically
  }

  async releaseTypingIndicator(_chatId: ChannelId, _senderId: UserId, messageId?: MessageId): Promise<void> {
    if (!messageId) return;
    const reactionId = this.activeReactions.get(messageId as string);
    if (!reactionId) return;
    try {
      await this.httpClient.im.messageReaction.delete({
        path: { message_id: messageId as string, reaction_id: reactionId },
      });
    } finally {
      this.activeReactions.delete(messageId as string);
    }
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
    for (const [messageId, reactionId] of this.activeReactions) {
      await this.httpClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }).catch(() => {});
    }
    this.activeReactions.clear();
    await this.wsClient.close({});
    this.connected = false;
  }
}

import type { PlatformClient } from '../../core/client.js';
import type { ChannelId, MessageId, UserId, Message, MessageContent } from '../../core/types.js';
import { StreamCapability, messageId } from '../../core/types.js';
import { XabotError } from '../../core/error.js';
import { toStandardMessage, fromMessageContent, fromMessageContentWithUpload, type WeixinMessage } from './message.js';
import { uploadMedia, fetchToTemp, safeUnlink } from './upload.js';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../../core/logger.js';
const log = createLogger('WechatClient');

export interface WechatConfig {
  /** bot_token — 扫码登录后获得 */
  token: string;
  /** API 基座地址，默认 https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /** 长轮询超时，默认 35000ms */
  longPollTimeoutMs?: number;
  /** Token 过期时自动重新扫码的回调 */
  onTokenExpired?: () => Promise<string>;
}

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const MAX_RETRY_DELAY_MS = 30_000;
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * WeChat iLink Bot platform client using HTTP long polling.
 *
 * Connects to ilinkai.weixin.qq.com:
 * - Long-polls POST /ilink/bot/getupdates for incoming messages
 * - Sends messages via POST /ilink/bot/sendmessage
 */
export class WechatClient implements PlatformClient {
  readonly platform = 'wechat' as const;

  private readonly config: WechatConfig;
  private token: string;
  private readonly baseUrl: string;
  private readonly pollTimeoutMs: number;
  private readonly xWechatUin: string;

  private getUpdatesBuf = '';
  private readonly contextTokenStore = new Map<string, string>();
  private readonly messageBuffer: Message[] = [];
  private messageResolve: ((msg: Message) => void) | null = null;
  private readonly typingTickets = new Map<string, { ticket: string; expiresAt: number }>();

  private connected = false;
  private abortCtrl: AbortController | null = null;

  constructor(config: WechatConfig) {
    this.config = config;
    this.token = config.token;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.pollTimeoutMs = config.longPollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.xWechatUin = randomBytes(4).toString('base64');
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.token}`,
      'X-WECHAT-UIN': this.xWechatUin,
    };
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.pollTimeoutMs + 30_000),
    });
  }

  // --------------------------------------------------------------------------
  // PlatformClient implementation
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;
    this.abortCtrl = new AbortController();
    this.connected = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    const ctrl = this.abortCtrl!;
    let retryDelay = 1000;

    while (!ctrl.signal.aborted) {
      try {
        const res = await this.post('/ilink/bot/getupdates', {
          get_updates_buf: this.getUpdatesBuf,
          base_info: { channel_version: '1' },
        });

        if (!res.ok) {
          throw XabotError.platform(`WechatClient poll error: HTTP ${res.status}`);
        }

        const data = (await res.json()) as {
          ret?: number;
          errcode?: number;
          get_updates_buf?: string;
          msgs?: WeixinMessage[];
        };

        // Real API returns { msgs, get_updates_buf } without ret field on success.
        // Only check ret/errcode when they are present.
        if (data.ret !== undefined && data.ret !== 0) {
          if (data.errcode === -14) {
            log.warn('session expired (errcode=-14)');
            if (this.config.onTokenExpired) {
              try {
                const newToken = await this.config.onTokenExpired();
                this.renewToken(newToken);
                retryDelay = 1000;
                continue;
              } catch (err) {
                log.error('token renewal failed: %s', err);
                void this.close();
                break;
              }
            }
            void this.close();
            break;
          }
          throw XabotError.platform(
            `WechatClient poll error: ret=${data.ret}, errcode=${data.errcode}`,
          );
        }

        this.getUpdatesBuf = data.get_updates_buf ?? '';

        for (const msg of data.msgs ?? []) {
          if (msg.message_type !== 1) continue;
          this.contextTokenStore.set(msg.from_user_id, msg.context_token);
          const standardMsg = toStandardMessage(msg);
          if (this.messageResolve) {
            const resolve = this.messageResolve;
            this.messageResolve = null;
            resolve(standardMsg);
          } else {
            this.messageBuffer.push(standardMsg);
          }
        }

        retryDelay = 1000;
      } catch (err) {
        if (ctrl.signal.aborted) break;
        log.error('poll error: %s', err);

        if (err instanceof Error && err.message.includes('401')) {
          log.error('auth failed (401), stopping');
          void this.close();
          break;
        }

        const delay = Math.min(retryDelay, MAX_RETRY_DELAY_MS);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async send(chatId: ChannelId, content: MessageContent): Promise<MessageId> {
    if (!this.connected) {
      throw XabotError.platform('WechatClient: not connected');
    }

    const contextToken = this.contextTokenStore.get(chatId) ?? '';
    let effective: MessageContent;

    if (content.type === 'text') {
      effective = content;
    } else {
      const src = content.source;
      let filePath: string | undefined;
      let tmpPath: string | undefined;

      try {
        if (src.localUri) {
          filePath = src.localUri;
        } else if (src.remoteUrl) {
          tmpPath = await fetchToTemp(src.remoteUrl);
          filePath = tmpPath;
        }

        if (filePath) {
          const mediaType = content.type === 'audio' ? 'file' : content.type;
          const result = await uploadMedia(this.baseUrl, this.token, this.xWechatUin, filePath, mediaType, chatId as string);
          log.info('upload success: %s (chatId=%s)', content.type, chatId);
          const body = fromMessageContentWithUpload(chatId, content, contextToken, result);
          return this._sendBody(body);
        }
      } catch (err) {
        log.warn('upload/fetch failed, fallback to text: %s', err);
        // upload or fetch failed — fall through to text fallback
      } finally {
        if (tmpPath) {
          await safeUnlink(tmpPath);
        }
      }

      if (src.localUri || src.remoteUrl) {
        effective = { type: 'text', text: `[${content.type}]` };
      } else {
        log.warn('send: %s has no source, sending placeholder', content.type);
        effective = { type: 'text', text: `[${content.type} 无法发送]` };
      }
    }

    const body = fromMessageContent(chatId, effective, contextToken);
    return this._sendBody(body);
  }

  private async _sendBody(body: import('./message.js').WeixinSendRequest): Promise<MessageId> {
    const res = await this.post('/ilink/bot/sendmessage', body);

    if (!res.ok) {
      throw XabotError.platform(`WechatClient send failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      ret?: number;
      errcode?: number;
      msg?: { client_id?: string };
    };

    if (data.ret !== undefined && data.ret !== 0) {
      throw XabotError.platform(
        `WechatClient send failed: ret=${data.ret}, errcode=${data.errcode}`,
      );
    }

    return messageId(data.msg?.client_id ?? String(Date.now()));
  }

  messages(): AsyncIterable<Message> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Message> {
        return {
          async next(): Promise<IteratorResult<Message>> {
            if (self.messageBuffer.length > 0) {
              return { value: self.messageBuffer.shift()!, done: false };
            }
            if (self.abortCtrl?.signal.aborted) {
              return { value: undefined as never, done: true };
            }
            return new Promise<IteratorResult<Message>>((resolve) => {
              self.messageResolve = (msg: Message) => {
                self.messageResolve = null;
                if (self.abortCtrl?.signal.aborted) {
                  resolve({ value: undefined as never, done: true });
                } else {
                  resolve({ value: msg, done: false });
                }
              };
            });
          },
        };
      },
    };
  }

  /** Replace token and reset poll state — used after token renewal. */
  renewToken(newToken: string): void {
    this.token = newToken;
    this.getUpdatesBuf = '';
    this.connected = true;
    if (!this.abortCtrl || this.abortCtrl.signal.aborted) {
      this.abortCtrl = new AbortController();
      void this.pollLoop();
    }
  }

  streamCapability(): StreamCapability {
    return StreamCapability.NonStreaming;
  }

  async healthCheck(): Promise<void> {
    if (!this.connected || !this.token) {
      throw XabotError.platform('WechatClient: not connected or no token');
    }
  }

  // --------------------------------------------------------------------------
  // Typing indicator
  // --------------------------------------------------------------------------

  private async fetchTypingTicket(userId: string): Promise<string> {
    const cached = this.typingTickets.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.ticket;

    const res = await this.post('/ilink/bot/getconfig', {
      ilink_user_id: userId,
      base_info: { channel_version: '2.0.0' },
    });
    if (!res.ok) throw new Error(`getconfig failed: HTTP ${res.status}`);

    const data = (await res.json()) as { typing_ticket?: string };
    if (!data.typing_ticket) throw new Error('getconfig returned no typing_ticket');

    this.typingTickets.set(userId, {
      ticket: data.typing_ticket,
      expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
    });
    return data.typing_ticket;
  }

  private async sendTypingStatus(userId: string, status: 1 | 2): Promise<void> {
    const ticket = await this.fetchTypingTicket(userId);
    await this.post('/ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status,
    });
  }

  async beginProcessing(_chatId: ChannelId, senderId: UserId, _messageId?: MessageId): Promise<void> {
    await this.sendTypingStatus(senderId as string, 1);
  }

  async endProcessing(_chatId: ChannelId, senderId: UserId, _messageId?: MessageId): Promise<void> {
    await this.sendTypingStatus(senderId as string, 2);
  }

  async close(): Promise<void> {
    if (!this.abortCtrl) return;
    this.abortCtrl.abort();
    this.connected = false;
    if (this.messageResolve) {
      this.messageResolve({} as Message);
      this.messageResolve = null;
    }
    this.abortCtrl = null;
    this.messageBuffer.length = 0;
    this.contextTokenStore.clear();
    this.typingTickets.clear();
  }
}

import type { PlatformClient } from '../../core/client.js';
import type { ChannelId, MessageId, Message, MessageContent } from '../../core/types.js';
import { StreamCapability, messageId } from '../../core/types.js';
import { XabotError } from '../../core/error.js';
import { toStandardMessage, fromMessageContent, type WeixinMessage } from './message.js';
import { randomBytes } from 'node:crypto';

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
            console.error('[WechatClient] session expired (errcode=-14)');
            if (this.config.onTokenExpired) {
              try {
                const newToken = await this.config.onTokenExpired();
                this.renewToken(newToken);
                retryDelay = 1000;
                continue;
              } catch (err) {
                console.error('[WechatClient] token renewal failed:', err);
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
        console.error('WechatClient poll error:', err);

        if (err instanceof Error && err.message.includes('401')) {
          console.error('[WechatClient] auth failed (401), stopping');
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
    const body = fromMessageContent(chatId, content, contextToken);

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
  }
}

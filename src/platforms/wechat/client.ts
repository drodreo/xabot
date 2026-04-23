import type { PlatformClient } from '../../core/client.js';
import type {
  ChannelId,
  MessageId,
  Message,
  MessageContent,
} from '../../core/types.js';
import { StreamCapability, messageId, channelId, userId } from '../../core/types.js';
import { toStandardMessage, fromMessageContent, type WechatMessageEvent } from './message.js';

export interface WechatConfig {
  appId: string;
  appSecret: string;
  longPollTimeoutMs?: number; // default 35000ms
  baseUrl?: string; // ilink_bot API base URL
}

const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_BASE_URL = 'https://api.ilink.bot';
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Wechat platform client using HTTP long polling.
 *
 * Connects to ilink_bot API:
 * - Authenticates with appId/appSecret to get an access token
 * - Long-polls GET /api/messages?timeout=<ms> for incoming events
 * - Sends messages via POST /api/messages/send
 */
export class WechatClient implements PlatformClient {
  readonly platform = 'wechat' as const;

  private readonly config: WechatConfig;
  private readonly baseUrl: string;
  private readonly pollTimeoutMs: number;

  private accessToken: string | null = null;
  private connected = false;
  private abortCtrl: AbortController | null = null;

  /** Buffer of incoming messages pushed by the polling loop. */
  private messageBuffer: Message[] = [];

  /** Resolver called when the polling loop has a message ready. */
  private messageResolve: ((msg: Message) => void) | null = null;

  constructor(config: WechatConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.pollTimeoutMs = config.longPollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async fetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
    if (!this.accessToken) {
      throw new Error('WechatClient: not authenticated — call connect() first');
    }
    const url = `${this.baseUrl}${path}`;
    const headers = {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${this.accessToken}`,
    };
    return fetch(url, { ...init, method: init?.method ?? 'GET', headers });
  }

  /** Obtain (or refresh) the access token via ilink_bot /api/auth/token. */
  private async fetchAccessToken(): Promise<string> {
    const url = `${this.baseUrl}/api/auth/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(`WechatClient auth failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as { accessToken?: string; token?: string };
    const token = json.accessToken ?? json.token;
    if (!token) {
      throw new Error('WechatClient auth failed: no access token in response');
    }
    return token;
  }

  // --------------------------------------------------------------------------
  // PlatformClient implementation
  // --------------------------------------------------------------------------

  /**
   * Authenticate with ilink_bot and start the long-polling loop.
   * The polling runs in the background; messages() consumes from it.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.accessToken = await this.fetchAccessToken();
    this.abortCtrl = new AbortController();
    this.connected = true;

    // Start the background polling loop.
    // Errors are recovered with exponential back-off; the loop stops when
    // abortCtrl signals abort (i.e., close() was called).
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    const ctrl = this.abortCtrl!;
    let retryDelay = 1000;

    while (!ctrl.signal.aborted) {
      try {
        const res = await this.fetchWithAuth(
          `/api/messages?timeout=${this.pollTimeoutMs}`,
          {
            signal: ctrl.signal,
            headers: { Accept: 'application/json' },
          },
        );

        if (!res.ok) {
          // 401 特殊处理：刷新 token，不 throw，直接 continue 重试
          if (res.status === 401) {
            this.accessToken = await this.fetchAccessToken();
            continue;
          }
          // 其他 4xx：不可重试，退出循环
          if (res.status >= 400 && res.status < 500) {
            break; // 退出 while，不是 throw
          }
          // 5xx：throw 进 catch 做 back-off 重试
          throw new Error(`WechatClient poll error: HTTP ${res.status}`);
        }

        // Reset back-off on successful poll
        retryDelay = 1000;

        const events = (await res.json()) as WechatMessageEvent[];
        for (const event of events) {
          const msg = toStandardMessage(event);

          if (this.messageResolve) {
            const resolve = this.messageResolve;
            this.messageResolve = null;
            resolve(msg);
          } else {
            this.messageBuffer.push(msg);
          }
        }
      } catch {
        if (ctrl.signal.aborted) break;

        const delay = Math.min(retryDelay, MAX_RETRY_DELAY_MS);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);

        // Wait before retrying
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async send(chatId: ChannelId, content: MessageContent): Promise<MessageId> {
    const body = fromMessageContent(chatId, content);

    const doSend = async (): Promise<Response> =>
      this.fetchWithAuth('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    let res = await doSend();

    // On 401, refresh token and retry once
    if (res.status === 401) {
      this.accessToken = await this.fetchAccessToken();
      res = await doSend();
    }

    if (!res.ok) {
      throw new Error(`WechatClient send failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as { msgId?: string; messageId?: string };
    const id = json.msgId ?? json.messageId;
    if (!id) {
      throw new Error('WechatClient send failed: no msgId in response');
    }

    return messageId(id);
  }

  messages(): AsyncIterable<Message> {
    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async (): Promise<IteratorResult<Message>> => {
            if (this.abortCtrl?.signal.aborted) {
              return { done: true, value: undefined };
            }

            // FIFO: drain buffered messages first.
            if (this.messageBuffer.length > 0) {
              const msg = this.messageBuffer.shift()!;
              return { done: false, value: msg };
            }

            // Wait for the next message from the polling loop.
            const msg = await new Promise<Message>((resolve) => {
              this.messageResolve = resolve;
            });

            if (this.abortCtrl?.signal.aborted) {
              return { done: true, value: undefined };
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

  async healthCheck(): Promise<void> {
    if (!this.connected || !this.accessToken) {
      throw new Error('WechatClient not connected');
    }
    // Long-polling is the health check — if connect() succeeded, we're healthy.
  }

  async close(): Promise<void> {
    if (!this.abortCtrl) return;

    // Signal the polling loop to stop.
    this.abortCtrl.abort();

    // Resolve any pending iterator so it exits instead of hanging.
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve({
        id: messageId(''),
        chatId: channelId(''),
        senderId: userId(''),
        content: { type: 'text', text: '' },
        direction: 'incoming',
      });
    }

    this.connected = false;
    this.accessToken = null;
  }
}

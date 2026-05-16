import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WechatClient, type WechatConfig } from './client.js';
import { StreamCapability, channelId } from '../../core/types.js';

// --------------------------------------------------------------------------
// Mock fetch
// --------------------------------------------------------------------------

const mockFetch = vi.fn<(...args: any[]) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

function makeJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const hangingPoll = (): Promise<Response> => new Promise<Response>(() => {});

function makeConfig(overrides?: Partial<WechatConfig>): WechatConfig {
  return {
    token: 'test_token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    longPollTimeoutMs: 5000,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('WechatClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('sets platform to "wechat"', () => {
      const client = new WechatClient(makeConfig());
      expect(client.platform).toBe('wechat');
    });

    it('uses default baseUrl when not provided', () => {
      const client = new WechatClient({ token: 't' });
      expect((client as any).baseUrl).toBe('https://ilinkai.weixin.qq.com');
    });

    it('uses custom baseUrl when provided', () => {
      const client = new WechatClient(makeConfig({ baseUrl: 'https://custom.url' }));
      expect((client as any).baseUrl).toBe('https://custom.url');
    });

    it('generates xWechatUin as base64 string', () => {
      const client = new WechatClient(makeConfig());
      const uin = (client as any).xWechatUin as string;
      expect(uin).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(Buffer.from(uin, 'base64').length).toBe(4);
    });
  });

  // --------------------------------------------------------------------------
  // connect()
  // --------------------------------------------------------------------------

  describe('connect()', () => {
    it('sets connected=true and starts pollLoop', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();

      expect((client as any).connected).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
      await client.close();
    });

    it('is idempotent', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();
      await client.connect();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      await client.close();
    });
  });

  // --------------------------------------------------------------------------
  // pollLoop()
  // --------------------------------------------------------------------------

  describe('pollLoop()', () => {
    it('converts msgs to standard Messages and buffers them', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          ret: 0,
          get_updates_buf: 'buf2',
          msgs: [{
            from_user_id: 'user_alice',
            to_user_id: 'bot_123',
            message_type: 1,
            context_token: 'ctx_1',
            item_list: [{ type: 1, text_item: { text: 'hello' } }],
            msg_id: 'msg_123',
          }],
        }))
        .mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      const iter = client.messages()[Symbol.asyncIterator]();
      const result = await iter.next();

      expect(result.done).toBe(false);
      expect(result.value.content).toEqual({ type: 'text', text: 'hello' });
      expect(result.value.chatId).toBe('user_alice');
      await client.close();
    });

    it('updates getUpdatesBuf on empty msgs', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({ ret: 0, get_updates_buf: 'next_buf', msgs: [] }))
        .mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();
      await new Promise((r) => setTimeout(r, 10));

      expect((client as any).getUpdatesBuf).toBe('next_buf');
      await client.close();
    });

    it('caches context_token per from_user_id', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          ret: 0,
          get_updates_buf: 'buf2',
          msgs: [{
            from_user_id: 'user_bob',
            to_user_id: 'bot_123',
            message_type: 1,
            context_token: 'ctx_bob',
            item_list: [{ type: 1, text_item: { text: 'hi' } }],
          }],
        }))
        .mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();
      await new Promise((r) => setTimeout(r, 10));

      expect((client as any).contextTokenStore.get('user_bob')).toBe('ctx_bob');
      await client.close();
    });

    it('skips non-USER messages (message_type !== 1)', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          ret: 0,
          get_updates_buf: 'buf2',
          msgs: [{
            from_user_id: 'user_bot',
            to_user_id: 'bot_123',
            message_type: 2,
            context_token: 'ctx_bot',
            item_list: [{ type: 1, text_item: { text: 'bot msg' } }],
          }],
        }))
        .mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();
      await new Promise((r) => setTimeout(r, 10));

      const iter = client.messages()[Symbol.asyncIterator]();
      const timeout = Promise.race([
        iter.next(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
      ]);
      await expect(timeout).rejects.toThrow('timeout');
      await client.close();
    });

    it('aborts on errcode === -14', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ ret: -1, errcode: -14 }));

      const client = new WechatClient(makeConfig());
      await client.connect();
      await new Promise((r) => setTimeout(r, 10));

      expect((client as any).abortCtrl).toBeNull();
      expect((client as any).connected).toBe(false);
    });

    it('retries on poll error', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce(makeJsonResponse({ ret: 0, get_updates_buf: 'ok', msgs: [] }))
        .mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      await new Promise((r) => setTimeout(r, 1500));

      expect(mockFetch).toHaveBeenCalledTimes(3);
      await client.close();
    });

    it('throws on 401 without retry', async () => {
      mockFetch.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'));

      const client = new WechatClient(makeConfig());
      await client.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect((client as any).connected).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  describe('send()', () => {
    it('POSTs correct body to /ilink/bot/sendmessage', async () => {
      mockFetch
        .mockImplementationOnce(hangingPoll)
        .mockResolvedValueOnce(makeJsonResponse({ ret: 0, msg: { client_id: 'sent_001' } }));

      const client = new WechatClient(makeConfig());
      await client.connect();
      (client as any).contextTokenStore.set('user_alice', 'ctx_alice');

      const result = await client.send(channelId('user_alice'), { type: 'text', text: 'hello' });

      expect(result).toBe('sent_001');
      const sendCall = mockFetch.mock.calls[1]!;
      expect(sendCall[0]).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
      const body = JSON.parse((sendCall[1] as any).body);
      expect(body.msg.to_user_id).toBe('user_alice');
      expect(body.msg.context_token).toBe('ctx_alice');
      expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }]);
      expect(body.base_info).toEqual({ channel_version: '1' });
      await client.close();
    });

    it('uses empty context_token when not cached', async () => {
      mockFetch
        .mockImplementationOnce(hangingPoll)
        .mockResolvedValueOnce(makeJsonResponse({ ret: 0, msg: { client_id: 'sent_002' } }));

      const client = new WechatClient(makeConfig());
      await client.connect();

      await client.send(channelId('user_unknown'), { type: 'text', text: 'hi' });

      const sendCall = mockFetch.mock.calls[1]!;
      const body = JSON.parse((sendCall[1] as any).body);
      expect(body.msg.context_token).toBe('');
      await client.close();
    });

    it('throws when ret !== 0', async () => {
      mockFetch
        .mockImplementationOnce(hangingPoll)
        .mockResolvedValueOnce(makeJsonResponse({ ret: -1, errcode: 10003 }));

      const client = new WechatClient(makeConfig());
      await client.connect();

      await expect(
        client.send(channelId('user_alice'), { type: 'text', text: 'hello' }),
      ).rejects.toThrow('WechatClient send failed');
      await client.close();
    });

    it('throws when not connected', async () => {
      const client = new WechatClient(makeConfig());
      await expect(
        client.send(channelId('user_alice'), { type: 'text', text: 'hello' }),
      ).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // messages()
  // --------------------------------------------------------------------------

  describe('messages()', () => {
    it('returns an AsyncIterable', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();

      const msgs = client.messages();
      expect(typeof msgs[Symbol.asyncIterator]).toBe('function');
      await client.close();
    });

    it('yields buffered messages', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          ret: 0,
          get_updates_buf: 'buf2',
          msgs: [{
            from_user_id: 'user_alice',
            to_user_id: 'bot_123',
            message_type: 1,
            context_token: 'ctx_1',
            item_list: [{ type: 1, text_item: { text: 'hello' } }],
            msg_id: 'msg_123',
          }],
        }))
        .mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      const msgs: import('../../core/types.js').Message[] = [];
      for await (const msg of client.messages()) {
        msgs.push(msg);
        break;
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toEqual({ type: 'text', text: 'hello' });
      await client.close();
    });

    it('returns done after close', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();

      const iter = client.messages()[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      await client.close();

      const result = await nextPromise;
      expect(result.done).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // streamCapability()
  // --------------------------------------------------------------------------

  describe('streamCapability()', () => {
    it('returns NonStreaming', () => {
      const client = new WechatClient(makeConfig());
      expect(client.streamCapability()).toBe(StreamCapability.NonStreaming);
    });
  });

  // --------------------------------------------------------------------------
  // healthCheck()
  // --------------------------------------------------------------------------

  describe('healthCheck()', () => {
    it('passes when connected', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();
      await expect(client.healthCheck()).resolves.toBeUndefined();
      await client.close();
    });

    it('throws when not connected', async () => {
      const client = new WechatClient(makeConfig());
      await expect(client.healthCheck()).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // close()
  // --------------------------------------------------------------------------

  describe('close()', () => {
    it('stops polling and marks disconnected', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();
      await client.close();

      expect((client as any).connected).toBe(false);
      expect((client as any).abortCtrl).toBeNull();
    });

    it('is idempotent', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();
      await client.close();
      await client.close();

      expect((client as any).connected).toBe(false);
    });

    it('resolves pending iterator to done', async () => {
      mockFetch.mockImplementationOnce(hangingPoll);
      const client = new WechatClient(makeConfig());
      await client.connect();

      const iter = client.messages()[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      await client.close();

      const result = await nextPromise;
      expect(result.done).toBe(true);
    });
  });
});

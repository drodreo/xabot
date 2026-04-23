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

/** Returns a promise that never resolves — used tosimulate a hanging long-poll. */
const hangingPoll = (): Promise<Response> =>
  new Promise<Response>(() => {});

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WechatConfig>): WechatConfig {
  return {
    appId: 'wx_app_id',
    appSecret: 'wx_secret',
    longPollTimeoutMs: 5000,
    baseUrl: 'https://api.ilink.bot',
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
  });

  afterEach(() => {
    vi.useRealTimers();
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
      const client = new WechatClient({ appId: 'a', appSecret: 'b' });
      expect((client as any).baseUrl).toBe('https://api.ilink.bot');
    });

    it('uses custom baseUrl when provided', () => {
      const client = new WechatClient(makeConfig({ baseUrl: 'https://custom.api' }));
      expect((client as any).baseUrl).toBe('https://custom.api');
    });

    it('defaults longPollTimeoutMs to 35000', () => {
      const client = new WechatClient({ appId: 'a', appSecret: 'b' });
      expect((client as any).pollTimeoutMs).toBe(35000);
    });
  });

  // --------------------------------------------------------------------------
  // connect()
  // --------------------------------------------------------------------------

  describe('connect()', () => {
    it('POSTs credentials to /api/auth/token and stores the access token', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token_abc' }));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.ilink.bot/api/auth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: 'wx_app_id', appSecret: 'wx_secret' }),
        }),
      );
    });

    it('is idempotent (multiple calls do not re-authenticate)', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token_abc' }));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();
      await client.connect(); // should return immediately

      // Only one auth call should have been made
      expect(mockFetch).toHaveBeenCalledTimes(2); // auth + first poll
    });

    it('starts long-polling immediately after auth', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token_xyz' }));
      mockFetch.mockResolvedValueOnce(makeJsonResponse([])); // first poll resolves
      mockFetch.mockImplementationOnce(hangingPoll); // second poll hangs

      const client = new WechatClient(makeConfig());
      await client.connect();

      // The second fetch call should be the first long-poll request
      expect(mockFetch.mock.calls[1]![0]).toBe(
        'https://api.ilink.bot/api/messages?timeout=5000',
      );
      expect((mockFetch.mock.calls[1]![1] as Record<string, unknown>).method).toBe('GET');
    });

    it('throws when auth fails with non-ok status', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'bad creds' }, 401));

      const client = new WechatClient(makeConfig());
      await expect(client.connect()).rejects.toThrow('WechatClient auth failed');
    });

    it('throws when auth response has no access token', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({}));

      const client = new WechatClient(makeConfig());
      await expect(client.connect()).rejects.toThrow(
        'WechatClient auth failed: no access token',
      );
    });
  });

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  describe('send()', () => {
    it('POSTs a text message to /api/messages/send with correct body', async () => {
      // Mock sequence:
      // 1. Auth token → resolved (pollLoop consumes during connect)
      // 2. First poll → hang forever (pollLoop waits on this)
      // 3. Send → msgId response
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll); // first poll hangs
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ msgId: 'sent_001' }));

      const client = new WechatClient(makeConfig());
      await client.connect();
      const result = await client.send(channelId('user_alice'), {
        type: 'text',
        text: 'hello from bot',
      });

      expect(result).toBe('sent_001');
      // The third fetch call should be the send request
      const sendCall = mockFetch.mock.calls[2]!;
      expect(sendCall[0]).toBe('https://api.ilink.bot/api/messages/send');
      const req = sendCall[1] as Record<string, unknown>;
      expect(JSON.parse(req.body as string)).toEqual({
        toUser: 'user_alice',
        msgType: 'text',
        content: 'hello from bot',
      });
    });

    it('includes mediaUrl for image messages', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll); // first poll hangs
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ msgId: 'sent_img' }));

      const client = new WechatClient(makeConfig());
      await client.connect();
      await client.send(channelId('user_bob'), {
        type: 'image',
        url: 'https://cdn.example.com/photo.png',
      });

      const sendCall = mockFetch.mock.calls[2]!;
      expect(sendCall[0]).toBe('https://api.ilink.bot/api/messages/send');
      const req = sendCall[1] as Record<string, unknown>;
      expect(JSON.parse(req.body as string)).toMatchObject({
        toUser: 'user_bob',
        msgType: 'image',
        content: 'https://cdn.example.com/photo.png',
        mediaUrl: 'https://cdn.example.com/photo.png',
      });
    });

    it('throws when send returns non-ok status', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll);
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'server error' }, 500));

      const client = new WechatClient(makeConfig());
      await client.connect();
      await expect(
        client.send(channelId('user_alice'), { type: 'text', text: 'test' }),
      ).rejects.toThrow('WechatClient send failed: HTTP 500');
    });

    it('throws when send response has no msgId', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll);
      mockFetch.mockResolvedValueOnce(makeJsonResponse({}));

      const client = new WechatClient(makeConfig());
      await client.connect();
      await expect(
        client.send(channelId('user_alice'), { type: 'text', text: 'test' }),
      ).rejects.toThrow('WechatClient send failed: no msgId');
    });

    it('throws when not connected', async () => {
      const client = new WechatClient(makeConfig());
      await expect(
        client.send(channelId('user_alice'), { type: 'text', text: 'test' }),
      ).rejects.toThrow('WechatClient: not authenticated');
    });
  });

  // --------------------------------------------------------------------------
  // messages()
  // --------------------------------------------------------------------------

  describe('messages()', () => {
    it('returns an AsyncIterable', () => {
      const client = new WechatClient(makeConfig());
      const iterable = client.messages();
      expect(typeof (iterable as any)[Symbol.asyncIterator]).toBe('function');
    });

    it('yields buffered messages via for-await-of', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse([
          {
            msgId: 'poll_msg_001',
            fromUserName: 'user_alice',
            toUserName: 'bot_channel',
            msgType: 'text',
            content: 'hello from wechat',
          },
        ]),
      );
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      const messages: any[] = [];
      for await (const msg of client.messages()) {
        messages.push(msg);
        break;
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toEqual({ type: 'text', text: 'hello from wechat' });
      expect(messages[0].id).toBe('poll_msg_001');
      expect(messages[0].chatId).toBe('bot_channel');
      expect(messages[0].senderId).toBe('user_alice');
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
    it('resolves when connected', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();
      await expect(client.healthCheck()).resolves.toBeUndefined();
    });

    it('throws when not connected', async () => {
      const client = new WechatClient(makeConfig());
      await expect(client.healthCheck()).rejects.toThrow(
        'WechatClient not connected',
      );
    });
  });

  // --------------------------------------------------------------------------
  // close()
  // --------------------------------------------------------------------------

  describe('close()', () => {
    it('stops the polling loop and marks client as disconnected', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();
      await client.close();

      await expect(client.healthCheck()).rejects.toThrow('WechatClient not connected');
    });

    it('is safe to call when not connected', async () => {
      const client = new WechatClient(makeConfig());
      await client.close(); // must not throw
      await client.close();
    });

    it('close() while messages() iterator is suspended causes iterator to return done:true', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      mockFetch.mockImplementationOnce(hangingPoll); // first poll hangs

      const client = new WechatClient(makeConfig());
      await client.connect();

      const msgIter = client.messages()[Symbol.asyncIterator]();
      const nextP = msgIter.next(); // iterator suspends waiting for message

      await client.close();

      const { done } = await nextP;
      expect(done).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // pollLoop HTTP error handling
  // --------------------------------------------------------------------------

  describe('pollLoop HTTP error handling', () => {
    it('401 → refreshes token and continues polling without throwing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      // Sequence: auth → poll(401) → token refresh → poll(empty) → poll(hangs)
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token_a' }));
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'token expired' }, 401));
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token_b' }));
      mockFetch.mockResolvedValueOnce(makeJsonResponse([]));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      // Let 401 + token refresh + retry sequence play out
      await vi.advanceTimersByTimeAsync(100);

      // Token refresh should have been called (not a poll call, separate fetch)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.ilink.bot/api/auth/token',
        expect.any(Object),
      );

      // Poll calls: poll1(401) + poll2(empty) + poll3(hanging) = 3
      const pollCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/messages'),
      );
      expect(pollCalls).toHaveLength(3);

      // poll2 should use the refreshed token
      expect((pollCalls[1]![1] as Record<string, unknown>).headers).toMatchObject({
        Authorization: 'Bearer token_b',
      });
    });

    it('403/404 → exits the polling loop without retrying', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      // Sequence: auth → poll(403) → loop exits
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token' }));
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'forbidden' }, 403));
      mockFetch.mockImplementationOnce(hangingPoll); // never reached

      const client = new WechatClient(makeConfig());
      await client.connect();

      // Let the 403 response be processed
      await vi.advanceTimersByTimeAsync(100);

      // Only one poll call should have been made (loop exited via break, no retry)
      const pollCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/messages'),
      );
      expect(pollCalls).toHaveLength(1);
      // The 403 Response was returned (status lives on the Response, not init)
      // We verify the call was made to the poll endpoint
      expect(pollCalls[0]![0]).toContain('/api/messages');

      await client.close();
    });

    it('500 → retries with back-off (throws to catch block)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      // Sequence: auth → poll(500, back-off) → [after delay] poll(empty) → poll(hangs)
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'token' }));
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'server error' }, 500));
      mockFetch.mockResolvedValueOnce(makeJsonResponse([]));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      // Advance past the initial back-off delay (1000ms)
      await vi.advanceTimersByTimeAsync(1100);

      // Poll calls: poll1(500) + poll2(empty) + poll3(hanging) = 3
      const pollCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/messages'),
      );
      expect(pollCalls).toHaveLength(3);
      expect(pollCalls[0]![0]).toContain('/api/messages'); // first was poll, not token refresh

      await client.close();
    });
  });

  // --------------------------------------------------------------------------
  // network error retry
  // --------------------------------------------------------------------------

  describe('network error retry', () => {
    it('re-polls after a fetch network error', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      mockFetch.mockResolvedValueOnce(makeJsonResponse({ accessToken: 'tok' }));
      // First poll throws
      mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
      // Second poll succeeds
      mockFetch.mockResolvedValueOnce(makeJsonResponse([]));
      mockFetch.mockImplementationOnce(hangingPoll);

      const client = new WechatClient(makeConfig());
      await client.connect();

      // Advance timers to trigger the retry back-off
      await vi.advanceTimersByTimeAsync(1100); // first back-off = 1000 ms

      const pollCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/messages'),
      );
      // At least: auth(1) + failed poll(1) + successful poll(1) = 3
      expect(pollCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from './client.js';
import { StreamCapability, channelId } from '../../core/types.js';
import type { FeishuMessageEvent } from './message.js';

// Mock state shared between mock factory and test code
const mockState = {
  wsClientStart: vi.fn<() => Promise<void>>(),
  wsClientClose: vi.fn<() => Promise<void>>(),
  httpMessageCreate: vi.fn(),
  eventDispatcherRegister: vi.fn(),
};

// Use ESM-safe class constructors so `new WSClient(...)` works
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockWSClient {
    start = mockState.wsClientStart;
    close = mockState.wsClientClose;
  }

  class MockClient {
    im = {
      message: {
        create: mockState.httpMessageCreate,
      },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ code: 0, data: { reaction_id: 'r-1' } }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
    };
  }

  class MockEventDispatcher {
    register = mockState.eventDispatcherRegister.mockReturnThis();
  }

  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    Domain: { Feishu: 'feishu' },
    LoggerLevel: { info: 2, debug: 3, trace: 4 },
  };
});

describe('FeishuClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.wsClientStart.mockResolvedValue(undefined);
    mockState.wsClientClose.mockResolvedValue(undefined);
    mockState.httpMessageCreate.mockReset();
    mockState.eventDispatcherRegister.mockReset().mockReturnThis();
  });

  describe('constructor', () => {
    it('creates a FeishuClient with correct platform', () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      expect(client.platform).toBe('feishu');
    });
  });

  describe('connect()', () => {
    it('calls wsClient.start with the eventDispatcher', async () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      expect(mockState.wsClientStart).toHaveBeenCalledWith({
        eventDispatcher: expect.any(Object),
      });
    });

    it('is idempotent (multiple calls are fine)', async () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await client.connect();
      expect(mockState.wsClientStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('send()', () => {
    it('sends a text message via HTTP client', async () => {
      mockState.httpMessageCreate.mockResolvedValue({
        code: 0,
        data: { message_id: 'om_sent_msg' },
      });

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      const result = await client.send(channelId('oc_chat1'), { type: 'text', text: 'hello' });

      expect(mockState.httpMessageCreate).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_chat1',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        params: { receive_id_type: 'chat_id' },
      });
      expect(result).toBe('om_sent_msg');
    });

    it('sends an image message', async () => {
      mockState.httpMessageCreate.mockResolvedValue({
        code: 0,
        data: { message_id: 'om_img' },
      });

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.send(channelId('oc_chat1'), { type: 'image', source: { localUri: '', remoteUrl: 'img_v2_abc', mimeType: '', sizeBytes: 0 } });

      expect(mockState.httpMessageCreate).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_chat1',
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_v2_abc' }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    });

    it('sends a file message', async () => {
      mockState.httpMessageCreate.mockResolvedValue({
        code: 0,
        data: { message_id: 'om_file' },
      });

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.send(channelId('oc_chat1'), {
        type: 'file',
        source: { localUri: '', remoteUrl: 'file_v2_xyz', mimeType: '', sizeBytes: 0 },
      });

      expect(mockState.httpMessageCreate).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_chat1',
          msg_type: 'file',
          content: JSON.stringify({ file_key: 'file_v2_xyz', file_name: 'file_v2_xyz' }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    });

    it('throws when send fails with no message_id', async () => {
      mockState.httpMessageCreate.mockResolvedValue({ code: 0, data: {} });

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await expect(
        client.send(channelId('oc_chat1'), { type: 'text', text: 'hello' }),
      ).rejects.toThrow('Feishu send failed: no message_id returned');
    });

    it('throws when send returns a non-zero code', async () => {
      mockState.httpMessageCreate.mockResolvedValue({
        code: 99991,
        msg: 'rate limit exceeded',
        data: {},
      });

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await expect(
        client.send(channelId('oc_chat1'), { type: 'text', text: 'hello' }),
      ).rejects.toThrow('Feishu API error: code=99991, msg=rate limit exceeded');
    });
  });

  describe('messages()', () => {
    it('returns an AsyncIterable', () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      const iterable = client.messages();
      expect(typeof (iterable as any)[Symbol.asyncIterator]).toBe('function');
    });

    it('yields incoming messages via for-await-of', async () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });

      // The event handler was registered during construction.
      // Simulate an incoming text message directly via the client's message buffer.
      const mockEvent: FeishuMessageEvent = {
        sender: {
          sender_id: { open_id: 'ou_sender' },
          sender_type: 'user',
        },
        message: {
          message_id: 'om_incoming',
          chat_id: 'oc_chat_incoming',
          create_time: '2025-01-01T00:00:00Z',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'incoming message' }),
        },
      };

      // Collect one message from the async iterator
      const collectPromise = (async () => {
        const msgs: any[] = [];
        for await (const msg of client.messages()) {
          msgs.push(msg);
          break;
        }
        return msgs;
      })();

      // Trigger the internal handler by simulating the WebSocket event
      // (the client buffers the event, and the iterator picks it up)
      const registeredHandler = mockState.eventDispatcherRegister.mock.calls.at(-1)?.[0]?.['im.message.receive_v1'];

      // If the handler was registered, call it to trigger the message flow
      if (registeredHandler) {
        await registeredHandler(mockEvent);
      }

      const result = await collectPromise;
      expect(result).toHaveLength(1);
      expect(result[0].content).toEqual({ type: 'text', text: 'incoming message' });
      expect(result[0].id).toBe('om_incoming');
    });
  });

  describe('streamCapability()', () => {
    it('returns NonStreaming', () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      expect(client.streamCapability()).toBe(StreamCapability.NonStreaming);
    });
  });

  describe('healthCheck()', () => {
    it('resolves when connected and API returns valid token', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ code: 0, tenant_access_token: 'mock-token' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await expect(client.healthCheck()).resolves.toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('throws when not connected', async () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await expect(client.healthCheck()).rejects.toThrow(
        'FeishuClient not connected',
      );
    });

    it('throws when fetch fails', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await expect(client.healthCheck()).rejects.toThrow('Feishu auth failed');

      vi.unstubAllGlobals();
    });
  });

  describe('close()', () => {
    it('calls wsClient.close', async () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await client.close();
      expect(mockState.wsClientClose).toHaveBeenCalledWith({});
    });

    it('marks client as not connected', async () => {
      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await client.close();
      await expect(client.healthCheck()).rejects.toThrow(
        'FeishuClient not connected',
      );
    });
  });

  describe('listEventSubscriptions()', () => {
    it('returns the event list on success', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0, tenant_access_token: 'mock-token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ code: 0, data: { events: ['im.message.receive_v1', 'im.message.send_v1'] } }),
        });
      vi.stubGlobal('fetch', fetchMock);

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      const result = await client.listEventSubscriptions();
      expect(result).toEqual(['im.message.receive_v1', 'im.message.send_v1']);

      vi.unstubAllGlobals();
    });

    it('throws when HTTP request fails', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await expect(client.listEventSubscriptions()).rejects.toThrow('HTTP 401');

      vi.unstubAllGlobals();
    });

    it('throws when API returns non-zero code', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0, tenant_access_token: 'mock-token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 999, msg: 'permission denied' }),
        });
      vi.stubGlobal('fetch', fetchMock);

      const client = new FeishuClient({ appId: 'app-123', appSecret: 'secret-456' });
      await client.connect();
      await expect(client.listEventSubscriptions()).rejects.toThrow('code=999');

      vi.unstubAllGlobals();
    });
  });
});

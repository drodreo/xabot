import { describe, it, expect, vi, beforeEach } from 'vitest';
import { channelId, sessionId } from '../core/types.js';
import type { ChannelId, SessionId } from '../core/types.js';
import { sessionId as makeSessionId } from '../core/types.js';
import type { Client } from '@agentclientprotocol/sdk';
import {
  AcpHandler,
  type AgentNotification,
  type PermissionRequest,
  type ProactiveMessage,
} from './handler.js';
import { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

// Mutable references populated by vi.mock factory and updated in beforeEach.
let _mockConn: {
  __testInitialize: ReturnType<typeof vi.fn>;
  __testNewSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  startReader: ReturnType<typeof vi.fn>;
  __testDispatch: ReturnType<typeof vi.fn>;
};
let _handler: AcpHandler;
let _client: Client;

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn().mockReturnValue({
    readable: {
      getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
    },
    writable: {
      getWriter: () => ({ write: async () => {}, releaseLock: () => {} }),
    },
  }),
  ClientSideConnection: vi.fn(),
  AgentSideConnection: vi.fn(),
}));

vi.mock('node:process', () => ({
  cwd: vi.fn(() => '/fake/cwd'),
  stdin: { readable: {} },
  stdout: { writable: {} },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpSession', () => {
  let AcpSession: typeof import('./session.js').AcpSession;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Fresh mock connection for each test.
    _mockConn = {
      __testInitialize: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      __testNewSession: vi.fn().mockImplementation(() =>
        Promise.resolve({ sessionId: `test-${Math.random().toString(36).slice(2)}` }),
      ),
      prompt: vi.fn().mockResolvedValue(undefined),
      startReader: vi.fn().mockImplementation((handler: AcpHandler, client: Client) => {
        _handler = handler;
        _client = client;
      }),
      __testDispatch: vi.fn().mockImplementation((msg: unknown) => {
        const m = msg as { method: string; params: Record<string, unknown> };
        if (m.method === 'send_message') {
          _handler?.pushProactive({
            chatId: m.params.chatId as string,
            content: m.params.content as string,
          });
        }
      }),
    };

    const mod = await import('./session.js');
    AcpSession = mod.AcpSession;
  });

  // -------------------------------------------------------------------------
  // connect()
  // -------------------------------------------------------------------------

  it('connect() returns an AcpSession instance', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    expect(session).toBeInstanceOf(AcpSession);
  });

  it('connect() calls ndJsonStream with stdout and stdin', async () => {
    const sdk = await import('@agentclientprotocol/sdk');
    // Call without a connection argument so a real NDJSON stream is created.
    await AcpSession.connect();
    expect(sdk.ndJsonStream).toHaveBeenCalledOnce();
  });

  it('connect() calls __testInitialize before returning', async () => {
    await AcpSession.connect(_mockConn as unknown as never);
    expect(_mockConn.__testInitialize).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // getOrCreateSession()
  // -------------------------------------------------------------------------

  it('getOrCreateSession() creates a new session on first call', async () => {
    _mockConn.__testNewSession.mockResolvedValueOnce({ sessionId: 'sid-1' });
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const chatId = channelId('chat-1');

    const sid = await session.getOrCreateSession(chatId);

    expect(_mockConn.__testNewSession).toHaveBeenCalledTimes(1);
    expect(sid).toBe('sid-1');
  });

  it('getOrCreateSession() reuses the same session for the same chatId', async () => {
    _mockConn.__testNewSession.mockResolvedValueOnce({ sessionId: 'sid-1' });
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const chatId = channelId('chat-1');

    const sid1 = await session.getOrCreateSession(chatId);
    const sid2 = await session.getOrCreateSession(chatId);

    expect(sid1).toBe(sid2);
    expect(_mockConn.__testNewSession).toHaveBeenCalledTimes(1);
  });

  it('different chatIds get independent sessions', async () => {
    _mockConn.__testNewSession
      .mockResolvedValueOnce({ sessionId: 'sid-1' })
      .mockResolvedValueOnce({ sessionId: 'sid-2' });
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const chat1 = channelId('chat-1');
    const chat2 = channelId('chat-2');

    const sid1 = await session.getOrCreateSession(chat1);
    const sid2 = await session.getOrCreateSession(chat2);

    expect(sid1).not.toBe(sid2);
    expect(_mockConn.__testNewSession).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // prompt()
  // -------------------------------------------------------------------------

  it('prompt() sends the prompt to the correct session', async () => {
    _mockConn.__testNewSession.mockResolvedValueOnce({ sessionId: 'sid-1' });
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const chatId = channelId('chat-1');
    await session.getOrCreateSession(chatId);

    const content = [{ type: 'text', text: 'hello' }] as const;
    await session.prompt(sessionId('sid-1'), [...content]);

    expect(_mockConn.prompt).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      prompt: expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
    });
  });

  // -------------------------------------------------------------------------
  // notifications()
  // -------------------------------------------------------------------------

  it('notifications() yields items pushed via client.sessionUpdate', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const client = session.__testClient;

    const notifIter = session.notifications()[Symbol.asyncIterator]();

    const next1 = notifIter.next();
    await (client.sessionUpdate as (n: unknown) => Promise<void>)({
      sessionId: sessionId('sid-1'),
      content: '',
    });
    const { value: n1, done: d1 } = await next1;
    expect(d1).toBe(false);
    expect((n1 as { sessionId: SessionId }).sessionId).toBe(sessionId('sid-1'));

    const next2 = notifIter.next();
    await (client.sessionUpdate as (n: unknown) => Promise<void>)({
      sessionId: sessionId('sid-2'),
      content: '',
    });
    const { value: n2, done: d2 } = await next2;
    expect(d2).toBe(false);
    expect((n2 as { sessionId: SessionId }).sessionId).toBe(sessionId('sid-2'));
  });

  // -------------------------------------------------------------------------
  // permissionRequests()
  // -------------------------------------------------------------------------

  it('permissionRequests() yields items via client.requestPermission', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const client = session.__testClient;

    const permIter = session.permissionRequests()[Symbol.asyncIterator]();

    const next1 = permIter.next();
    await (client.requestPermission as (p: unknown) => Promise<unknown>)({
      sessionId: sessionId('sid-1'),
      toolCall: {} as never,
      options: [],
    });
    const { value: p1, done: d1 } = await next1;
    expect(d1).toBe(false);
    expect((p1 as { sessionId: SessionId }).sessionId).toBe(sessionId('sid-1'));
  });

  // -------------------------------------------------------------------------
  // proactiveMessages()
  // -------------------------------------------------------------------------

  it('proactiveMessages() yields items dispatched via __testDispatch (send_message)', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const conn = session.__testConnection;

    const proactiveIter = session.proactiveMessages()[Symbol.asyncIterator]();

    const next1 = proactiveIter.next();
    conn.__testDispatch({
      jsonrpc: '2.0',
      method: 'send_message',
      params: { chatId: 'chat-1', content: 'hello proactive' },
    });
    const { value: p1, done: d1 } = await next1;
    expect(d1).toBe(false);
    expect((p1 as { chatId: string }).chatId).toBe('chat-1');
    expect((p1 as { content: string }).content).toBe('hello proactive');

    const next2 = proactiveIter.next();
    conn.__testDispatch({
      jsonrpc: '2.0',
      method: 'send_message',
      params: { chatId: 'chat-2', content: 'second proactive' },
    });
    const { value: p2, done: d2 } = await next2;
    expect(d2).toBe(false);
    expect((p2 as { chatId: string }).chatId).toBe('chat-2');
  });

  it('proactiveMessages() supports multiple concurrent consumers (multicast)', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const conn = session.__testConnection;

    const iter1 = session.proactiveMessages()[Symbol.asyncIterator]();
    const iter2 = session.proactiveMessages()[Symbol.asyncIterator]();

    const next1a = iter1.next();
    const next2a = iter2.next();
    conn.__testDispatch({
      jsonrpc: '2.0',
      method: 'send_message',
      params: { chatId: 'chat-multi', content: 'broadcast' },
    });

    const [r1, r2] = await Promise.all([next1a, next2a]);
    expect(r1.done).toBe(false);
    expect((r1.value as { content: string }).content).toBe('broadcast');
    expect(r2.done).toBe(false);
    expect((r2.value as { content: string }).content).toBe('broadcast');
  });

  it('close() while proactiveMessages() is suspended causes iterator to return done:true', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const proactiveIter = session.proactiveMessages()[Symbol.asyncIterator]();

    const nextP = proactiveIter.next();

    session.close();

    const { done } = await nextP;
    expect(done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  it('close() does not throw', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    expect(() => session.close()).not.toThrow();
  });

  it('close() while notifications() is suspended causes iterator to return done:true', async () => {
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const notifIter = session.notifications()[Symbol.asyncIterator]();

    const nextP = notifIter.next();

    session.close();

    const { done } = await nextP;
    expect(done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // multiple chatIds independent sessions
  // -------------------------------------------------------------------------

  it('multiple chatIds maintain independent session state', async () => {
    _mockConn.__testNewSession
      .mockResolvedValueOnce({ sessionId: 'sid-A' })
      .mockResolvedValueOnce({ sessionId: 'sid-B' })
      .mockResolvedValueOnce({ sessionId: 'sid-C' });
    const session = await AcpSession.connect(_mockConn as unknown as never);
    const chatA = channelId('room-A');
    const chatB = channelId('room-B');
    const chatC = channelId('room-C');

    const sidA1 = await session.getOrCreateSession(chatA);
    const sidB1 = await session.getOrCreateSession(chatB);
    const sidA2 = await session.getOrCreateSession(chatA);
    const sidC1 = await session.getOrCreateSession(chatC);

    expect(sidA1).toBe(sidA2);
    expect(sidA1).not.toBe(sidB1);
    expect(sidB1).not.toBe(sidC1);
    expect(_mockConn.__testNewSession).toHaveBeenCalledTimes(3);
  });
});

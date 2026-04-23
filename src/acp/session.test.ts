import { describe, it, expect, vi, beforeEach } from 'vitest';
import { channelId, sessionId } from '../core/types.js';
import type { SessionId } from '../core/types.js';

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

interface MockClientConnection {
  newSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  closed: Promise<void>;
  signal: { aborted: boolean; addEventListener: ReturnType<typeof vi.fn> };
}

let mockConn: MockClientConnection;

vi.mock('@agentclientprotocol/sdk', () => {
  mockConn = {
    newSession: vi.fn<() => Promise<{ sessionId: string }>>(),
    prompt: vi.fn<() => Promise<void>>(),
    initialize: vi.fn<() => Promise<{ protocolVersion: number }>>(),
    closed: Promise.resolve(),
    signal: { aborted: false, addEventListener: vi.fn() },
  };
  const ClientSideConnectionMock = vi.fn(function(
    _factory: unknown,
    _stream: unknown,
  ) {
    const client = (_factory as (a: unknown) => Record<string, unknown>)(mockConn);
    return { ...client, ...mockConn };
  });
  return {
    ClientSideConnection: ClientSideConnectionMock,
    AgentSideConnection: vi.fn(),
    ndJsonStream: vi.fn().mockReturnValue({ readable: {}, writable: {} }),
  };
});

vi.mock('node:process', () => ({
  cwd: vi.fn(() => '/fake/cwd'),
  stdin: { readable: {} },
  stdout: { writable: {} },
}));

vi.mock('node:stream/web', () => ({
  ReadableStream: vi.fn(),
  WritableStream: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpSession', () => {
  let AcpSession: typeof import('./session.js').AcpSession;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('./session.js');
    AcpSession = mod.AcpSession;
  });

  // -------------------------------------------------------------------------
  // connect()
  // -------------------------------------------------------------------------

  it('connect() returns an AcpSession instance', async () => {
    const session = await AcpSession.connect();
    expect(session).toBeInstanceOf(AcpSession);
  });

  it('connect() calls ndJsonStream with stdout and stdin', async () => {
    const sdk = await import('@agentclientprotocol/sdk');
    await AcpSession.connect();
    expect(sdk.ndJsonStream).toHaveBeenCalledOnce();
  });

  it('connect() calls connection.initialize before returning', async () => {
    mockConn.initialize.mockResolvedValueOnce({ protocolVersion: 1 });
    await AcpSession.connect();
    expect(mockConn.initialize).toHaveBeenCalledWith({ protocolVersion: 1 });
  });

  // -------------------------------------------------------------------------
  // getOrCreateSession()
  // -------------------------------------------------------------------------

  it('getOrCreateSession() creates a new session on first call', async () => {
    mockConn.newSession.mockResolvedValueOnce({ sessionId: 'sid-1' });
    const session = await AcpSession.connect();
    const chatId = channelId('chat-1');

    const sid = await session.getOrCreateSession(chatId);

    expect(mockConn.newSession).toHaveBeenCalledTimes(1);
    expect(sid).toBe('sid-1');
  });

  it('getOrCreateSession() reuses the same session for the same chatId', async () => {
    mockConn.newSession.mockResolvedValueOnce({ sessionId: 'sid-1' });
    const session = await AcpSession.connect();
    const chatId = channelId('chat-1');

    const sid1 = await session.getOrCreateSession(chatId);
    const sid2 = await session.getOrCreateSession(chatId);

    expect(sid1).toBe(sid2);
    expect(mockConn.newSession).toHaveBeenCalledTimes(1);
  });

  it('different chatIds get independent sessions', async () => {
    mockConn.newSession
      .mockResolvedValueOnce({ sessionId: 'sid-1' })
      .mockResolvedValueOnce({ sessionId: 'sid-2' });
    const session = await AcpSession.connect();
    const chat1 = channelId('chat-1');
    const chat2 = channelId('chat-2');

    const sid1 = await session.getOrCreateSession(chat1);
    const sid2 = await session.getOrCreateSession(chat2);

    expect(sid1).not.toBe(sid2);
    expect(mockConn.newSession).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // prompt()
  // -------------------------------------------------------------------------

  it('prompt() sends the prompt to the correct session', async () => {
    mockConn.newSession.mockResolvedValueOnce({ sessionId: 'sid-1' });
    mockConn.prompt.mockResolvedValueOnce(undefined);
    const session = await AcpSession.connect();
    const chatId = channelId('chat-1');
    await session.getOrCreateSession(chatId);

    const content = [{ type: 'text', text: 'hello' }] as const;
    await session.prompt(sessionId('sid-1'), [...content]);

    expect(mockConn.prompt).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      prompt: expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
    });
  });

  // -------------------------------------------------------------------------
  // notifications()
  // -------------------------------------------------------------------------

  it('notifications() yields items pushed via client.sessionUpdate', async () => {
    const session = await AcpSession.connect();
    const client = session.__testClient;

    // Start the iterator — the async generator body runs on the first .next()
    // call, which installs the pushNotification patch and suspends at
    // `await waitNext`.  Callbacks triggered while suspended resolve that
    // promise, causing the generator to resume and yield the queued item.
    const notifIter = session.notifications()[Symbol.asyncIterator]();

    // Trigger the first notification.
    const next1 = notifIter.next();
    await (client.sessionUpdate as (n: unknown) => Promise<void>)({
      sessionId: sessionId('sid-1'),
      content: '',
    });
    const { value: n1, done: d1 } = await next1;
    expect(d1).toBe(false);
    expect((n1 as { sessionId: SessionId }).sessionId).toBe(sessionId('sid-1'));

    // Trigger the second notification.
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
    const session = await AcpSession.connect();
    const client = session.__testClient;

    // Same pattern as notifications(): start the iterator first so the patch
    // is installed, then trigger the callback.
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
  // close()
  // -------------------------------------------------------------------------

  it('close() does not throw', async () => {
    const session = await AcpSession.connect();
    expect(() => session.close()).not.toThrow();
  });

  it('close() while notifications() is suspended causes iterator to return done:true', async () => {
    const session = await AcpSession.connect();
    const notifIter = session.notifications()[Symbol.asyncIterator]();

    // Start iteration — it will suspend at waitNext (no items queued)
    const nextP = notifIter.next();

    // Close the session while iterator is suspended
    session.close();

    // Iterator should immediately return done: true
    const { done } = await nextP;
    expect(done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // multiple chatIds independent sessions
  // -------------------------------------------------------------------------

  it('multiple chatIds maintain independent session state', async () => {
    mockConn.newSession
      .mockResolvedValueOnce({ sessionId: 'sid-A' })
      .mockResolvedValueOnce({ sessionId: 'sid-B' })
      .mockResolvedValueOnce({ sessionId: 'sid-C' });
    const session = await AcpSession.connect();
    const chatA = channelId('room-A');
    const chatB = channelId('room-B');
    const chatC = channelId('room-C');

    const sidA1 = await session.getOrCreateSession(chatA);
    const sidB1 = await session.getOrCreateSession(chatB);
    const sidA2 = await session.getOrCreateSession(chatA); // same, no new call
    const sidC1 = await session.getOrCreateSession(chatC);

    expect(sidA1).toBe(sidA2);
    expect(sidA1).not.toBe(sidB1);
    expect(sidB1).not.toBe(sidC1);
    expect(mockConn.newSession).toHaveBeenCalledTimes(3);
  });
});

import { ndJsonStream, type SessionNotification, type RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { sessionId as makeSessionId, type ChannelId, type SessionId } from '../core/types.js';
import { AcpHandler, type AgentNotification, type PermissionRequest, type ProactiveMessage } from './handler.js';
import { Readable, Writable } from 'node:stream';
import { ReadableStream, WritableStream } from 'node:stream/web';

/**
 * AcpSession manages ACP sessions for downstream agent connections.
 *
 * Each chatId maps to one ACP SessionId. Sessions are created on demand
 * and multiplexed over a single NDJSON stream (stdin/stdout).
 *
 * Uses ndJsonStream directly (instead of ClientSideConnection) so that the
 * raw stream can be read and custom message types such as `send_message`
 * can be intercepted and routed to the proactive channel.
 *
 * ── Listener architecture ────────────────────────────────────────────────────
 * AcpSession has its own Set-based listener registries (#notificationListeners,
 * #permissionListeners, #proactiveListeners) separate from AcpHandler.
 * This is intentional:
 *   - AcpHandler listeners are used by the ACP cloud-side (e.g. Bridge push).
 *   - AcpSession listeners are used by session-level consumers (notifications(),
 *     permissionRequests(), proactiveMessages() async generators).
 * Both layers get notified via Connection.#dispatch → handler.pushProactive(),
 * which fan-outs to both the handler and session listener registries.
 */
export class AcpSession {
  private readonly chatToSession = new Map<ChannelId, SessionId>();
  private readonly connection: Connection;
  readonly #handler: AcpHandler;
  readonly #client: Client;
  #abortCtrl = new AbortController();

  // Multicast listener registries — each call to notifications() /
  // permissionRequests() / proactiveMessages() registers its own listener.
  readonly #notificationListeners = new Set<(n: AgentNotification) => void>();
  readonly #permissionListeners = new Set<(p: PermissionRequest) => void>();
  readonly #proactiveListeners = new Set<(p: ProactiveMessage) => void>();

  /** Exposed for testing only — the underlying AcpHandler. */
  get __testHandler(): AcpHandler {
    return this.#handler;
  }

  /** Exposed for testing only — the Client used in this session. */
  get __testClient(): Client {
    return this.#client;
  }

  /** Exposed for testing only — the underlying Connection. */
  get __testConnection(): Connection {
    return this.connection;
  }

  private constructor(connection: Connection, handler: AcpHandler, client: Client) {
    this.connection = connection;
    this.#handler = handler;
    this.#client = client;
  }

  /** Map an SDK SessionNotification → internal AgentNotification. */
  #mapSessionNotification(params: SessionNotification): AgentNotification {
    const update = params.update as Record<string, unknown>;
    let content: string;
    if (update && typeof update === 'object') {
      if ('content' in update && typeof update.content === 'string') {
        content = update.content;
      } else if ('text' in update && typeof update.text === 'string') {
        content = update.text;
      } else {
        content = JSON.stringify(update);
      }
    } else {
      content = String(update ?? '');
    }
    return { sessionId: makeSessionId(params.sessionId as string), content };
  }

  /** Map an SDK RequestPermissionRequest → internal PermissionRequest. */
  #mapPermissionRequest(params: RequestPermissionRequest): PermissionRequest {
    const toolCall = params.toolCall as Record<string, unknown>;
    const toolName = typeof toolCall?.name === 'string' ? toolCall.name : '';
    return {
      sessionId: makeSessionId(params.sessionId as string),
      name: toolName,
      options: params.options.map((o) => o.name),
    };
  }

  #notifyListeners(n: AgentNotification): void {
    for (const fn of this.#notificationListeners) fn(n);
  }

  #notifyPermissionListeners(p: PermissionRequest): void {
    for (const fn of this.#permissionListeners) fn(p);
  }

  #notifyProactiveListeners(p: ProactiveMessage): void {
    for (const fn of this.#proactiveListeners) fn(p);
  }

  /**
   * Establish an ACP connection over stdin/stdout.
   *
   * @param connection - Optional Connection instance for DI (used by tests).
   *                     When omitted, a real Connection is created over stdin/stdout.
   */
  static async connect(
    connection?: Connection,
  ): Promise<AcpSession> {
    let conn: Connection;
    if (connection) {
      conn = connection;
    } else {
      const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
      const stdout = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(stdout, stdin);
      conn = new Connection(stream);
    }

    const handler = new AcpHandler();

    // Late-bind `session` so client callbacks can capture it via closure.
    // This avoids the callback having a reference to an incompletely-initialised object.
    let session: AcpSession | undefined;

    const client: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        if (!session) return;
        const n = session.#mapSessionNotification(params);
        session.#notifyListeners(n);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        if (!session) return { outcome: { outcome: 'cancelled' } };
        const p = session.#mapPermissionRequest(params);
        session.#notifyPermissionListeners(p);
        return { outcome: { outcome: 'cancelled' } };
      },
    };

    await (conn.__testInitialize ?? conn.initialize)({ protocolVersion: 1 });
    conn.startReader(handler, client, () => session);

    session = new AcpSession(conn, handler, client);
    return session;
  }

  async getOrCreateSession(chatId: ChannelId): Promise<SessionId> {
    if (this.chatToSession.has(chatId)) {
      return this.chatToSession.get(chatId)!;
    }
    const result = await (this.connection.__testNewSession ?? this.connection.newSession)({
      cwd: process.cwd(),
      mcpServers: [],
    });
    const sid = makeSessionId(result.sessionId);
    this.chatToSession.set(chatId, sid);
    return sid;
  }

  async prompt(sessionId: SessionId, content: Parameters<Connection['prompt']>[0]['prompt']): Promise<void> {
    await this.connection.prompt({ sessionId, prompt: content });
  }

  async *notifications(): AsyncIterable<AgentNotification> {
    const queue: AgentNotification[] = [];
    let resolveNext!: () => void;
    let waitNext = new Promise<void>((r) => { resolveNext = r; });

    const abortPromise = new Promise<void>((resolve) => {
      this.#abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const listener = (n: AgentNotification) => {
      queue.push(n);
      resolveNext();
      waitNext = new Promise<void>((r) => { resolveNext = r; });
    };
    this.#notificationListeners.add(listener);
    try {
      while (true) {
        if (this.#abortCtrl.signal.aborted) break;
        const currentWaitNext = waitNext;
        if (queue.length === 0) {
          await Promise.race([currentWaitNext, abortPromise]);
          if (this.#abortCtrl.signal.aborted) break;
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      this.#notificationListeners.delete(listener);
    }
  }

  async *permissionRequests(): AsyncIterable<PermissionRequest> {
    const queue: PermissionRequest[] = [];
    let resolveNext!: () => void;
    let waitNext = new Promise<void>((r) => { resolveNext = r; });

    const abortPromise = new Promise<void>((resolve) => {
      this.#abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const listener = (p: PermissionRequest) => {
      queue.push(p);
      resolveNext();
      waitNext = new Promise<void>((r) => { resolveNext = r; });
    };
    this.#permissionListeners.add(listener);
    try {
      while (true) {
        if (this.#abortCtrl.signal.aborted) break;
        const currentWaitNext = waitNext;
        if (queue.length === 0) {
          await Promise.race([currentWaitNext, abortPromise]);
          if (this.#abortCtrl.signal.aborted) break;
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      this.#permissionListeners.delete(listener);
    }
  }

  async *proactiveMessages(): AsyncIterable<ProactiveMessage> {
    const queue: ProactiveMessage[] = [];
    let resolveNext!: () => void;
    let waitNext = new Promise<void>((r) => { resolveNext = r; });

    const abortPromise = new Promise<void>((resolve) => {
      this.#abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    // Route through AcpHandler.addProactiveListener so that
    // Connection.__testDispatch → handler.pushProactive reaches our listener.
    const listener = (p: ProactiveMessage) => {
      queue.push(p);
      resolveNext();
      waitNext = new Promise<void>((r) => { resolveNext = r; });
    };
    const unsubscribe = this.#handler.addProactiveListener(listener);
    try {
      while (true) {
        if (this.#abortCtrl.signal.aborted) break;
        const currentWaitNext = waitNext;
        if (queue.length === 0) {
          await Promise.race([currentWaitNext, abortPromise]);
          if (this.#abortCtrl.signal.aborted) break;
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    this.#abortCtrl.abort();
    this.chatToSession.clear();
  }
}

// ---------------------------------------------------------------------------
// Connection — thin wrapper around the NDJSON stream
// ---------------------------------------------------------------------------

type Stream = {
  writable: WritableStream<import('@agentclientprotocol/sdk').AnyMessage>;
  readable: ReadableStream<import('@agentclientprotocol/sdk').AnyMessage>;
};

/**
 * Speaks ACP over an NDJSON stream (stdin/stdout).
 *
 * Unlike ClientSideConnection, this reads the raw NDJSON stream so that
 * `send_message` notifications can be intercepted and routed to the proactive
 * channel instead of being silently dropped.
 */
class Connection {
  private readonly stream: Stream;
  private readerStarted = false;
  private readonly pendingRequests = new Map<string | number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }>();
  private nextId: number = 0;

  // Stored during startReader so __testDispatch can use them
  #handler?: AcpHandler;
  #client?: Client;
  #getSession?: () => AcpSession | undefined;

  constructor(stream: Stream) {
    this.stream = stream;
  }

  /**
   * Bypass the NDJSON stream for initialize.
   * Tests use this to avoid coordinating readable/writable streams.
   */
  __testInitialize(
    _params?: { protocolVersion: number },
  ): Promise<{ protocolVersion: number }> {
    return Promise.resolve({ protocolVersion: 1 });
  }

  /**
   * Bypass the NDJSON stream for newSession.
   * Tests use this to avoid coordinating readable/writable streams.
   */
  __testNewSession(
    _params?: { cwd: string; mcpServers: unknown[] },
  ): Promise<{ sessionId: string }> {
    return Promise.resolve({ sessionId: `test-${Math.random().toString(36).slice(2)}` });
  }

  /** Real initialize — sends over NDJSON. */
  async initialize(params: { protocolVersion: number }): Promise<{ protocolVersion: number }> {
    return (await this.#call('initialize', params)) as { protocolVersion: number };
  }

  /** Real newSession — sends over NDJSON. */
  async newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }> {
    return (await this.#call('newSession', params)) as { sessionId: string };
  }

  /** Real prompt — sends over NDJSON. */
  async prompt(params: { sessionId: string; prompt: unknown[] }): Promise<void> {
    await this.#call('prompt', params);
  }

  /**
   * Start reading the NDJSON stream and dispatching messages to the
   * appropriate handler callbacks.
   */
  startReader(
    handler: AcpHandler,
    client: Client,
    getSession: () => AcpSession | undefined,
  ): void {
    if (this.readerStarted) return;
    this.readerStarted = true;
    this.#handler = handler;
    this.#client = client;
    this.#getSession = getSession;

    const reader = this.stream.readable.getReader();

    // Schedule pump asynchronously so that connect() can complete initialize()
    // before the stream-reading pump starts.  Inside the async pump, each
    // reader.read() suspends until data arrives on the readable stream.
    Promise.resolve().then(function pump(this: Connection) {
      reader.read().then(({ done, value }) => {
        if (done) return;
        if (value) this.#dispatch(value, handler, client, getSession);
        if (!this.readerStarted) return;
        pump.call(this);
      }).catch((err) => {
        if (this.readerStarted) {
          console.error('[AcpSession] reader error:', err);
        }
      });
    }.bind(this));
  }

  /**
   * Set up the internal state needed by __testDispatch.
   * Used by tests when a plain object is passed to AcpSession.connect().
   */
  __testSetup(handler: AcpHandler, client: Client, getSession: () => AcpSession | undefined): void {
    this.#handler = handler;
    this.#client = client;
    this.#getSession = getSession;
  }

  /**
   * Dispatch a parsed message directly — bypasses the NDJSON reader.
   * Used in tests to inject messages without mocking TextDecoder / Uint8Array.
   */
  __testDispatch(msg: import('@agentclientprotocol/sdk').AnyMessage): void {
    if (this.#handler && this.#client) {
      this.#dispatch(msg, this.#handler, this.#client, this.#getSession ?? (() => undefined));
    }
  }

  #dispatch(
    msg: import('@agentclientprotocol/sdk').AnyMessage,
    handler: AcpHandler,
    client: Client,
    _getSession: () => AcpSession | undefined,
  ): void {
    if ('id' in msg && this.pendingRequests.has(msg.id as string | number)) {
      const entry = this.pendingRequests.get(msg.id as string | number)!;
      this.pendingRequests.delete(msg.id as string | number);
      if ('error' in msg) {
        entry.reject(new Error((msg as { error: { message: string } }).error.message));
      } else {
        entry.resolve((msg as { result: unknown }).result);
      }
      return;
    }

    if (!('id' in msg) && 'method' in msg) {
      const method = msg.method;
      const params = msg.params;

      if (method === 'sessionUpdate') {
        client.sessionUpdate(params as SessionNotification);
      } else if (method === 'requestPermission') {
        client.requestPermission(params as RequestPermissionRequest);
      } else if (method === 'send_message') {
        const p = params as { chatId: string; content: string };
        handler.pushProactive({ chatId: p.chatId as ChannelId, content: p.content });
      }
      return;
    }
  }

  async #call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: import('@agentclientprotocol/sdk').AnyMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const writer = this.stream.writable.getWriter();
    try {
      await writer.write(msg);
    } finally {
      writer.releaseLock();
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }
}

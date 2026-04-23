import { ClientSideConnection, ndJsonStream, type SessionNotification, type RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { sessionId, type ChannelId, type SessionId } from '../core/types.js';
import { AcpHandler, type AgentNotification, type PermissionRequest } from './handler.js';
import { Readable, Writable } from 'node:stream';
import { ReadableStream, WritableStream } from 'node:stream/web';

/**
 * AcpSession manages ACP sessions for downstream agent connections.
 *
 * Each chatId maps to one ACP SessionId. Sessions are created on demand
 * and multiplexed over a single ClientSideConnection (stdin/stdout).
 */
export class AcpSession {
  private readonly chatToSession = new Map<ChannelId, SessionId>();
  private readonly connection: ClientSideConnection;
  readonly #handler: AcpHandler;
  readonly #client: Client;
  #abortCtrl = new AbortController();

  // Multicast listener registries — each call to notifications() /
  // permissionRequests() registers its own listener on these sets.
  readonly #notificationListeners = new Set<(n: AgentNotification) => void>();
  readonly #permissionListeners = new Set<(p: PermissionRequest) => void>();

  /** Exposed for testing only — the underlying AcpHandler. */
  get __testHandler(): AcpHandler {
    return this.#handler;
  }

  /** Exposed for testing only — the Client used in this session. */
  get __testClient(): Client {
    return this.#client;
  }

  private constructor(connection: ClientSideConnection, handler: AcpHandler, client: Client) {
    this.connection = connection;
    this.#handler = handler;
    this.#client = client;
  }

  /**
   * Map an SDK SessionNotification → internal AgentNotification.
   *
   * The SDK type has a structured `update` discriminated union; we extract
   * a meaningful text content string from it.
   */
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
    return { sessionId: sessionId(params.sessionId as string), content };
  }

  /**
   * Map an SDK RequestPermissionRequest → internal PermissionRequest.
   *
   * SDK: { sessionId, options: PermissionOption[], toolCall: ToolCallUpdate }
   * Internal: { sessionId, name: string, options: string[] }
   */
  #mapPermissionRequest(params: RequestPermissionRequest): PermissionRequest {
    const toolCall = params.toolCall as Record<string, unknown>;
    const toolName = typeof toolCall?.name === 'string' ? toolCall.name : '';
    return {
      sessionId: sessionId(params.sessionId as string),
      name: toolName,
      options: params.options.map((o) => o.name),
    };
  }

  /** Push a notification to all registered listeners. */
  #notifyListeners(n: AgentNotification): void {
    for (const fn of this.#notificationListeners) fn(n);
  }

  /** Push a permission request to all registered listeners. */
  #notifyPermissionListeners(p: PermissionRequest): void {
    for (const fn of this.#permissionListeners) fn(p);
  }

  /**
   * Establish an ACP connection over stdin/stdout.
   */
  static async connect(): Promise<AcpSession> {
    const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
    const stdout = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(stdout, stdin);

    const handler = new AcpHandler();

    // The session is created lazily so the Client callbacks can capture `session`
    // via closure. This avoids the callback having a reference to an
    // incompletely-initialised object.
    let session: AcpSession | undefined;

    // xabot implements the Client role: receives sessionUpdate notifications
    // and requestPermission requests from the downstream agent.
    const client: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        if (session) session.#notifyListeners(session.#mapSessionNotification(params));
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        if (session) session.#notifyPermissionListeners(session.#mapPermissionRequest(params));
        return { outcome: { outcome: 'cancelled' } };
      },
    };

    const connection = new ClientSideConnection(
      (_agent: unknown) => client as Client,
      stream,
    );

    // ACP protocol requires an initialize handshake before any session methods.
    // See: https://agentclientprotocol.com/protocol/initialization
    await connection.initialize({ protocolVersion: 1 });

    session = new AcpSession(connection, handler, client);
    return session;
  }

  /**
   * Get or create an ACP session for the given chatId.
   * Multiple calls with the same chatId return the same SessionId.
   */
  async getOrCreateSession(chatId: ChannelId): Promise<SessionId> {
    if (this.chatToSession.has(chatId)) {
      return this.chatToSession.get(chatId)!;
    }
    const { sessionId: sid } = await this.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    this.chatToSession.set(chatId, sid);
    return sid;
  }

  /**
   * Send a prompt to the agent within an existing session.
   */
  async prompt(sessionId: SessionId, content: Parameters<ClientSideConnection['prompt']>[0]['content']): Promise<void> {
    await this.connection.prompt({ sessionId, prompt: content });
  }

  /**
   * Stream of session notifications from the agent.
   *
   * Supports multiple concurrent consumers — each call to notifications()
   * gets its own independent iterator backed by its own queue.
   */
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

  /**
   * Stream of permission requests from the agent.
   *
   * Supports multiple concurrent consumers.
   */
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

  /** Close the ACP connection and abort all pending operations. */
  close(): void {
    this.#abortCtrl.abort();
    this.chatToSession.clear();
  }
}

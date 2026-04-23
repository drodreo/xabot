import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from './index.js';
import { Router } from '../core/router.js';
import { agentId, channelId, sessionId, messageId, userId, type ChannelId, type SessionId, type Message } from '../core/types.js';
import type { AgentNotification } from '../acp/handler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msg(chatId: ReturnType<typeof channelId>, text: string): Message {
  return {
    id: messageId('msg-1'),
    chatId,
    senderId: userId('u1'),
    content: { type: 'text', text },
    direction: 'incoming',
  };
}

function notif(sid: ReturnType<typeof sessionId>, content: string): AgentNotification {
  return { sessionId: sid, content };
}

/**
 * A manual async iterator.
 *
 * Usage in tests:
 *   const q = new ManualIter<AgentNotification>();
 *   acpFns.notifications = () => q.iter();
 *   q.push(n1);
 *   q.push(n2);
 *   q.stop();           // signals end of stream
 *
 * The iterator drains its queue on each call to next(), so all pushed items
 * are delivered to the consumer before stop() takes effect.
 */
class ManualIter<T> {
  private queue: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | null = null;
  private stopped = false;

  push(item: T) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  stop() {
    this.stopped = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  /** Returns an AsyncIterable — for use with for-await-of. */
  iter(): AsyncIterable<T> {
    const self = this;
    return { [Symbol.asyncIterator]: function (): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          // Drain the queue first
          if (self.queue.length > 0) {
            return { value: self.queue.shift()!, done: false };
          }
          if (self.stopped) {
            return { value: undefined as never, done: true };
          }
          // Wait for next push() or stop()
          return new Promise<IteratorResult<T>>((r) => { self.waiting = r; });
        },
      };
    } };
  }
}

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  let i = 0;
  return {
    async *[Symbol.asyncIterator]() {
      while (i < items.length) yield items[i++]!;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge', () => {
  let router: Router;
  let bridge: Bridge;

  // Shared mutable mock-function refs — resolved at call time, not construction.
  const cloudFns = {
    messages: () => asyncIter<Message>([]),
    send: vi.fn<(chatId: ChannelId, content: { type: string; text: string }) => Promise<ReturnType<typeof messageId>>>(),
    close: vi.fn<() => Promise<void>>(),
  };
  const acpFns = {
    getOrCreateSession: vi.fn<(chatId: ChannelId) => Promise<ReturnType<typeof sessionId>>>(),
    prompt: vi.fn<(sid: SessionId, content: { type: string; text: string }[]) => Promise<void>>(),
    notifications: () => asyncIter<AgentNotification>([]),
    close: vi.fn<() => void>(),
  };

  beforeEach(() => {
    router = new Router();
    vi.clearAllMocks();
    cloudFns.messages = () => asyncIter<Message>([]);
    cloudFns.send = vi.fn().mockResolvedValue(messageId('mid-1'));
    cloudFns.close = vi.fn().mockResolvedValue(undefined);
    acpFns.getOrCreateSession = vi.fn();
    acpFns.prompt = vi.fn().mockResolvedValue(undefined);
    acpFns.notifications = () => asyncIter<AgentNotification>([]);
    acpFns.close = vi.fn();

    bridge = new Bridge(
      {
        platform: 'mock',
        connect: vi.fn().mockResolvedValue(undefined),
        send: cloudFns.send,
        messages: () => cloudFns.messages(),
        streamCapability: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(undefined),
        close: cloudFns.close,
      } as never,
      {
        getOrCreateSession: acpFns.getOrCreateSession,
        prompt: acpFns.prompt,
        notifications: () => acpFns.notifications(),
        close: acpFns.close,
      } as never,
      router,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── close() ─────────────────────────────────────────────────────────────

  it('close() aborts the cloud and ACP connections', async () => {
    await bridge.run();
    await bridge.close();

    expect(cloudFns.close).toHaveBeenCalled();
    expect(acpFns.close).toHaveBeenCalled();
  });

  it('close() is idempotent (multiple calls do not error)', async () => {
    await bridge.run();
    await bridge.close();
    await bridge.close(); // must not throw
  });

  // ── Cloud → Agent ───────────────────────────────────────────────────────

  it('a cloud message with a registered chatId is forwarded to ACP prompt', async () => {
    const chatA = channelId('chat-a');
    router.register(agentId('agent-a'), [chatA]);
    const sidA = sessionId('sid-a');

    cloudFns.messages = () => asyncIter<Message>([msg(chatA, 'hello agent')]);
    acpFns.getOrCreateSession.mockResolvedValue(sidA);

    await bridge.run();

    expect(acpFns.getOrCreateSession).toHaveBeenCalledWith(chatA);
    expect(acpFns.prompt).toHaveBeenCalledWith(sidA, [{ type: 'text', text: 'hello agent' }]);
  });

  it('a cloud message with no registered agent is discarded', async () => {
    const chatUnknown = channelId('chat-unknown');

    cloudFns.messages = () => asyncIter<Message>([msg(chatUnknown, 'hello?')]);

    await bridge.run();

    expect(acpFns.prompt).not.toHaveBeenCalled();
    expect(acpFns.getOrCreateSession).not.toHaveBeenCalled();
  });

  it('multiple cloud messages are processed in order', async () => {
    const chatA = channelId('chat-a');
    const chatB = channelId('chat-b');
    router.register(agentId('agent-a'), [chatA]);
    router.register(agentId('agent-b'), [chatB]);

    const sidA = sessionId('sid-a');
    const sidB = sessionId('sid-b');
    const order: string[] = [];

    cloudFns.messages = () =>
      asyncIter<Message>([
        msg(chatA, 'msg-1-for-a'),
        msg(chatB, 'msg-1-for-b'),
        msg(chatA, 'msg-2-for-a'),
      ]);

    acpFns.getOrCreateSession.mockImplementation(async (c) =>
      (c === chatA ? sidA : sidB) as ReturnType<typeof sessionId>,
    );
    acpFns.prompt.mockImplementation(async (sid: SessionId, content: unknown) => {
      const c = content as { text: string }[];
      order.push(`${String(sid)}:${c[0]!.text}`);
    });

    await bridge.run();

    expect(order).toEqual([
      'sid-a:msg-1-for-a',
      'sid-b:msg-1-for-b',
      'sid-a:msg-2-for-a',
    ]);
  });

  // ── Agent → Cloud ───────────────────────────────────────────────────────

  it('an agent notification with a known sessionId is sent to the correct chatId', async () => {
    const chatA = channelId('chat-a');
    router.register(agentId('agent-a'), [chatA]);
    const sidA = sessionId('sid-a');

    // ManualIter: notification is only delivered after cloud loop has set up mapping.
    const notifQueue = new ManualIter<AgentNotification>();
    cloudFns.messages = () => asyncIter<Message>([msg(chatA, 'trigger')]);
    acpFns.getOrCreateSession.mockResolvedValue(sidA);
    acpFns.notifications = () => notifQueue.iter();

    const runPromise = bridge.run();
    await new Promise((r) => setTimeout(r, 5)); // let cloud loop establish mapping
    notifQueue.push(notif(sidA, 'reply from agent'));
    notifQueue.stop();
    await runPromise;

    expect(cloudFns.send).toHaveBeenCalledWith(chatA, { type: 'text', text: 'reply from agent' });
  });

  it('an agent notification with an unknown sessionId is discarded', async () => {
    router.register(agentId('agent-a'), [channelId('chat-a')]);
    acpFns.getOrCreateSession.mockResolvedValue(sessionId('sid-a'));
    acpFns.notifications = () =>
      asyncIter<AgentNotification>([notif(sessionId('sid-unknown'), 'orphan reply')]);

    await bridge.run();

    expect(cloudFns.send).not.toHaveBeenCalled();
  });

  it('agent replies are routed to the correct chatId when multiple agents are active', async () => {
    const chatA = channelId('chat-a');
    const chatB = channelId('chat-b');
    router.register(agentId('agent-a'), [chatA]);
    router.register(agentId('agent-b'), [chatB]);

    const sidA = sessionId('sid-a');
    const sidB = sessionId('sid-b');

    const notifQueue = new ManualIter<AgentNotification>();
    cloudFns.messages = () =>
      asyncIter<Message>([msg(chatA, 'trigger-a'), msg(chatB, 'trigger-b')]);
    acpFns.getOrCreateSession.mockImplementation(async (c: ChannelId) =>
      (c === chatA ? sidA : sidB) as ReturnType<typeof sessionId>,
    );
    acpFns.notifications = () => notifQueue.iter();

    const runPromise = bridge.run();
    await new Promise((r) => setTimeout(r, 5)); // let cloud loop set up both mappings
    notifQueue.push(notif(sidA, 'reply-a'));
    notifQueue.push(notif(sidB, 'reply-b'));
    notifQueue.stop();
    await runPromise;

    expect(cloudFns.send).toHaveBeenCalledWith(chatA, { type: 'text', text: 'reply-a' });
    expect(cloudFns.send).toHaveBeenCalledWith(chatB, { type: 'text', text: 'reply-b' });
  });

  // ── close() aborts active loops ─────────────────────────────────────────

  it('close() terminates the cloud-messages loop', async () => {
    // A messages iterator that hangs (simulates a live stream)
    let resolveHang: () => void;
    const liveMessages: AsyncIterable<Message> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => { resolveHang = r; });
        yield { id: messageId('x'), chatId: channelId('c'), senderId: userId('u'), content: { type: 'text', text: 'x' }, direction: 'incoming' };
      },
    };

    cloudFns.messages = () => liveMessages;

    const runPromise = bridge.run();
    await new Promise((r) => setTimeout(r, 10));

    await bridge.close();
    resolveHang!(); // unblock the iterator so run() can finish
    await runPromise; // must not hang

    expect(cloudFns.close).toHaveBeenCalled();
  });
});

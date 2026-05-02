/**
 * Bridge 集成测试 — 端到端数据流验证
 *
 * 覆盖四条核心链路：
 *   L1: FeishuClient.messages() → Bridge → AcpSession.prompt()
 *   L2: AcpSession.notifications() → Bridge → FeishuClient.send()
 *   L3: discover() → chatId（cli/discover.test.ts 已覆盖，此处补充 Router 注册完整性）
 *   L4: 未实现（待 downstream send_message 支持后补充）
 *
 * 所有测试使用 mock PlatformClient / mock AcpSession，不依赖真实云端和 ACP SDK。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from './index.js';
import { Router } from '../core/router.js';
import type { PlatformClient } from '../core/client.js';
import type { AcpSession } from '../acp/session.js';
import {
  agentId,
  channelId,
  sessionId,
  messageId,
  userId,
  type ChannelId,
  type SessionId,
  type Message,
  type MessageContent,
} from '../core/types.js';
import type { AgentNotification, ProactiveMessage } from '../acp/handler.js';

// ─── ManualIter ───────────────────────────────────────────────────────────────

/**
 * A manual async iterator backed by a push queue.
 *
 * Usage:
 *   const q = new ManualIter<T>();
 *   subject.callback = () => q.iter();   // wire into something that returns AsyncIterable
 *   q.push(item);
 *   q.stop();
 *   for await (const x of q.iter()) { ... }
 *
 * The iterator drains its queue before reporting done, so all pushed items
 * are delivered before the stream ends.
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

  iter(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            if (self.queue.length > 0) return { value: self.queue.shift()!, done: false };
            if (self.stopped) return { value: undefined as never, done: true };
            return new Promise<IteratorResult<T>>((r) => { self.waiting = r; });
          },
        };
      },
    };
  }
}

// ─── SimpleBarrier ────────────────────────────────────────────────────────────

/**
 * A simple binary latch — blocks until `release()` is called once.
 * Used to order async operations without relying on setTimeout.
 */
class SimpleBarrier {
  private pending: Array<() => void> = [];

  async wait(): Promise<void> {
    return new Promise<void>((r) => { this.pending.push(r); });
  }

  release() {
    const wakeups = this.pending.splice(0);
    wakeups.forEach((r) => r());
  }
}

// ─── Empty async iterable factory ─────────────────────────────────────────────

/** Returns an async iterable that yields nothing and completes immediately. */
function emptyAsyncIter<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
      async next(): Promise<IteratorResult<T>> {
        return { done: true, value: undefined as never };
      },
    }),
  };
}

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockMessage(
  chatId: ChannelId,
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: messageId(`msg-${Math.random().toString(36).slice(2)}`),
    chatId,
    senderId: userId('u-sender'),
    content: { type: 'text', text } as MessageContent,
    direction: 'incoming',
    ...overrides,
  };
}

function mockNotification(sid: SessionId, content: string): AgentNotification {
  return { sessionId: sid, content };
}

function mockProactive(chatId: ChannelId, content: string): ProactiveMessage {
  return { chatId: chatId as string, content };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge integration', () => {
  let router: Router;
  let bridge: Bridge;

  // Per-test mutable refs — reassigned in beforeEach so state is always clean.
  let cloudMessagesIter: ManualIter<Message>;
  let cloudSendMock: ReturnType<typeof vi.fn>;
  let acpGetOrCreateSessionMock: ReturnType<typeof vi.fn>;
  let acpPromptMock: ReturnType<typeof vi.fn>;
  let acpNotificationsIter: ManualIter<AgentNotification>;
  let acpProactiveIter: ManualIter<ProactiveMessage>;

  beforeEach(() => {
    router = new Router();

    cloudMessagesIter = new ManualIter<Message>();
    cloudSendMock = vi.fn<(
      chatId: ChannelId,
      content: { type: string; text: string },
    ) => Promise<ReturnType<typeof messageId>>>().mockResolvedValue(messageId('mid-1'));

    acpGetOrCreateSessionMock = vi.fn<
      (chatId: ChannelId) => Promise<SessionId>
    >();
    acpPromptMock = vi.fn<(
      sid: SessionId,
      content: { type: string; text: string }[],
    ) => Promise<void>>().mockResolvedValue(undefined);

    acpNotificationsIter = new ManualIter<AgentNotification>();
    acpProactiveIter = new ManualIter<ProactiveMessage>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a Bridge wired to our per-test mocks.
   *
   * Uses emptyAsyncIter for notification/proactive channels so those loops
   * exit immediately when the iterator is consumed — no hanging.
   */
  function makeBridge(notifIter?: ManualIter<AgentNotification>, proactiveIter?: ManualIter<ProactiveMessage>): Bridge {
    const cloud: PlatformClient = {
      platform: 'mock',
      connect: vi.fn().mockResolvedValue(undefined),
      send: cloudSendMock,
      messages: () => cloudMessagesIter.iter(),
      streamCapability: vi.fn().mockReturnValue(0 as any),
      healthCheck: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const acp: AcpSession = {
      __testHandler: null as any,
      __testClient: null as any,
      getOrCreateSession: acpGetOrCreateSessionMock,
      prompt: acpPromptMock,
      notifications: () => (notifIter ?? acpNotificationsIter).iter(),
      permissionRequests: emptyAsyncIter(),
      proactiveMessages: () => (proactiveIter ?? acpProactiveIter).iter(),
      close: vi.fn(),
    };

    return new Bridge(cloud, acp, router);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // L1 — Cloud message → ACP prompt
  // ══════════════════════════════════════════════════════════════════════════

  it('L1: cloud text message reaches ACP prompt with correct session and content', async () => {
    const chat = channelId('chat-l1');
    router.register(agentId('agent-1'), [chat]);
    const sid = sessionId('sid-l1');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push(mockMessage(chat, 'hello downstream'));
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await bridge.run();

    expect(acpGetOrCreateSessionMock).toHaveBeenCalledWith(chat);
    expect(acpPromptMock).toHaveBeenCalledWith(sid, [
      { type: 'text', text: 'hello downstream' },
    ]);
  });

  it('L1: cloud image message is forwarded as text placeholder', async () => {
    const chat = channelId('chat-l1-img');
    router.register(agentId('agent-1'), [chat]);
    const sid = sessionId('sid-l1-img');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push({
      id: messageId('img-1'),
      chatId: chat,
      senderId: userId('u1'),
      content: { type: 'image', url: 'https://cdn.example.com/photo.png' } as MessageContent,
      direction: 'incoming',
    });
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await bridge.run();

    expect(acpPromptMock).toHaveBeenCalledWith(sid, [
      { type: 'text', text: '[image: https://cdn.example.com/photo.png]' },
    ]);
  });

  it('L1: cloud file message is forwarded as text placeholder with name', async () => {
    const chat = channelId('chat-l1-file');
    router.register(agentId('agent-1'), [chat]);
    const sid = sessionId('sid-l1-file');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push({
      id: messageId('file-1'),
      chatId: chat,
      senderId: userId('u1'),
      content: { type: 'file', url: 'https://cdn.example.com/doc.pdf', name: 'report.pdf' } as MessageContent,
      direction: 'incoming',
    });
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await bridge.run();

    expect(acpPromptMock).toHaveBeenCalledWith(sid, [
      { type: 'text', text: '[file: report.pdf]' },
    ]);
  });

  it('L1: unregistered chatId is silently discarded (not routed)', async () => {
    const unregistered = channelId('chat-no-agent');
    cloudMessagesIter.push(mockMessage(unregistered, 'hello?'));
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await bridge.run();

    expect(acpGetOrCreateSessionMock).not.toHaveBeenCalled();
    expect(acpPromptMock).not.toHaveBeenCalled();
  });

  it('L1: multiple messages to different agents are routed independently', async () => {
    const chatA = channelId('chat-a-l1');
    const chatB = channelId('chat-b-l1');
    router.register(agentId('agent-a'), [chatA]);
    router.register(agentId('agent-b'), [chatB]);
    const sidA = sessionId('sid-a-l1');
    const sidB = sessionId('sid-b-l1');

    acpGetOrCreateSessionMock.mockImplementation(async (c: ChannelId) =>
      (c === chatA ? sidA : sidB) as SessionId,
    );

    cloudMessagesIter.push(mockMessage(chatA, 'msg-a'));
    cloudMessagesIter.push(mockMessage(chatB, 'msg-b'));
    cloudMessagesIter.push(mockMessage(chatA, 'msg-a-2'));
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await bridge.run();

    expect(acpPromptMock).toHaveBeenNthCalledWith(1, sidA, [
      { type: 'text', text: 'msg-a' },
    ]);
    expect(acpPromptMock).toHaveBeenNthCalledWith(2, sidB, [
      { type: 'text', text: 'msg-b' },
    ]);
    expect(acpPromptMock).toHaveBeenNthCalledWith(3, sidA, [
      { type: 'text', text: 'msg-a-2' },
    ]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // L2 — ACP notification → Cloud send
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * L2 is tricky because the cloud-messages loop must run first to populate
   * the sessionId→chatId reverse map before the notifications loop can route
   * a reply.  We use a SimpleBarrier to guarantee ordering:
   *
   *   1. Cloud loop registers the session mapping first (releases bar.cloudReady)
   *   2. Notifications loop waits on bar.cloudReady before pushing notifications
   *   3. Both loops run concurrently but our barrier ensures the cloud loop
   *      sets up the mapping before the notifications loop tries to use it.
   *
   * The proactive iterator is left empty and stopped so that loop exits immediately.
   */
  it('L2: ACP notification reaches the correct chatId via the reverse mapping', async () => {
    const chat = channelId('chat-l2');
    router.register(agentId('agent-1'), [chat]);
    const sid = sessionId('sid-l2');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push(mockMessage(chat, 'trigger'));

    bridge = makeBridge();

    // Barrier to sequence: cloud loop registers mapping BEFORE we push the notification.
    const mappingReady = new SimpleBarrier();

    acpPromptMock.mockImplementation(async () => {
      mappingReady.release();
    });

    const runPromise = bridge.run();

    // Wait for the cloud loop to have processed the message and set up the reverse map.
    await mappingReady.wait();

    // Now push the notification — the reverse mapping is guaranteed to exist.
    acpNotificationsIter.push(mockNotification(sid, 'reply from agent'));
    // Must stop both iterators so both loops can exit after processing.
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    await runPromise;

    expect(cloudSendMock).toHaveBeenCalledWith(chat, {
      type: 'text',
      text: 'reply from agent',
    });
  });

  it('L2: notification with unknown sessionId is discarded without calling send', async () => {
    const chat = channelId('chat-l2-unknown');
    router.register(agentId('agent-1'), [chat]);
    const sid = sessionId('sid-known');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push(mockMessage(chat, 'trigger'));

    const bar = new SimpleBarrier();
    acpPromptMock.mockImplementation(() => { bar.release(); return Promise.resolve(); });

    bridge = makeBridge();
    const runPromise = bridge.run();
    await bar.wait();

    // Push a notification for a different sessionId that was never registered.
    acpNotificationsIter.push(mockNotification(sessionId('sid-orphan'), 'orphan reply'));
    // Must stop all iterators so all loops can exit.
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    await runPromise;

    expect(cloudSendMock).not.toHaveBeenCalled();
  });

  it('L2: replies to multiple concurrent sessions go to the correct chatIds', async () => {
    const chatA = channelId('chat-a-l2');
    const chatB = channelId('chat-b-l2');
    router.register(agentId('agent-a'), [chatA]);
    router.register(agentId('agent-b'), [chatB]);
    const sidA = sessionId('sid-a-l2');
    const sidB = sessionId('sid-b-l2');

    acpGetOrCreateSessionMock.mockImplementation(async (c: ChannelId) =>
      (c === chatA ? sidA : sidB) as SessionId,
    );

    cloudMessagesIter.push(mockMessage(chatA, 'trigger-a'));
    cloudMessagesIter.push(mockMessage(chatB, 'trigger-b'));

    // Barriers to sequence: one per chat.
    const barA = new SimpleBarrier();
    const barB = new SimpleBarrier();

    acpPromptMock.mockImplementation(async () => {
      barA.release();
      barB.release();
    });

    bridge = makeBridge();
    const runPromise = bridge.run();

    await barA.wait();
    await barB.wait();

    // Both mappings are now established — push both notifications.
    acpNotificationsIter.push(mockNotification(sidA, 'reply-a'));
    acpNotificationsIter.push(mockNotification(sidB, 'reply-b'));
    // Must stop all iterators so all loops can exit.
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    await runPromise;

    expect(cloudSendMock).toHaveBeenCalledWith(chatA, {
      type: 'text',
      text: 'reply-a',
    });
    expect(cloudSendMock).toHaveBeenCalledWith(chatB, {
      type: 'text',
      text: 'reply-b',
    });
  });

  it('L2: cloud.send() failure in notification loop does not crash bridge', async () => {
    const chat = channelId('chat-l2-err');
    router.register(agentId('agent-1'), [chat]);
    const sid = sessionId('sid-l2-err');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push(mockMessage(chat, 'trigger'));

    const bar = new SimpleBarrier();
    acpPromptMock.mockImplementation(() => { bar.release(); return Promise.resolve(); });

    bridge = makeBridge();
    const runPromise = bridge.run();
    await bar.wait();

    // First notification succeeds, second fails.
    cloudSendMock
      .mockResolvedValueOnce(messageId('mid-ok'))
      .mockRejectedValueOnce(new Error('transient network error'));

    acpNotificationsIter.push(mockNotification(sid, 'reply-1'));
    acpNotificationsIter.push(mockNotification(sid, 'reply-2'));
    // Must stop all iterators so all loops can exit.
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    await runPromise;

    // Both notifications were processed; the error was caught and logged.
    expect(cloudSendMock).toHaveBeenCalledTimes(2);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // L3 — Router registration + discover integration
  // ══════════════════════════════════════════════════════════════════════════
  // (cli/discover.test.ts covers discover() end-to-end.
  //  We verify the Router side here — that chatId registration is correct.)

  it('L3: Router.register() enables Bridge to resolve chatId → agentId', async () => {
    const chat = channelId('chat-l3');
    router.register(agentId('agent-discover'), [chat]);

    expect(router.resolve(chat)).toBe(agentId('agent-discover'));
  });

  it('L3: same chatId registered by multiple agents — last writer wins', async () => {
    const chat = channelId('chat-shared');
    router.register(agentId('agent-old'), [chat]);
    router.register(agentId('agent-new'), [chat]);

    expect(router.resolve(chat)).toBe(agentId('agent-new'));
  });

  it('L3: unregistered chatId returns undefined from router', async () => {
    expect(router.resolve(channelId('chat-never-registered'))).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Cross-chain: L1 + L2 together
  // ══════════════════════════════════════════════════════════════════════════

  it('L1+L2: full round-trip — cloud message → prompt → notification → cloud send', async () => {
    const chat = channelId('chat-roundtrip');
    router.register(agentId('agent-rt'), [chat]);
    const sid = sessionId('sid-rt');

    acpGetOrCreateSessionMock.mockResolvedValue(sid);
    cloudMessagesIter.push(mockMessage(chat, 'round-trip test'));

    const mappingReady = new SimpleBarrier();
    const promptImpl = vi.fn<typeof acpPromptMock>();
    promptImpl.mockImplementation(async () => {
      mappingReady.release();
    });

    const notifIter = new ManualIter<AgentNotification>();
    const proactiveIter = new ManualIter<ProactiveMessage>();

    bridge = (() => {
      const cloud: PlatformClient = {
        platform: 'mock',
        connect: vi.fn().mockResolvedValue(undefined),
        send: cloudSendMock,
        messages: () => cloudMessagesIter.iter(),
        streamCapability: vi.fn().mockReturnValue(0 as any),
        healthCheck: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const acp: AcpSession = {
        __testHandler: null as any,
        __testClient: null as any,
        getOrCreateSession: acpGetOrCreateSessionMock,
        prompt: promptImpl,
        notifications: () => notifIter.iter(),
        permissionRequests: emptyAsyncIter(),
        proactiveMessages: () => proactiveIter.iter(),
        close: vi.fn(),
      };
      return new Bridge(cloud, acp, router);
    })();

    const runPromise = bridge.run();

    // Wait for the cloud loop to have processed the message and set the reverse map.
    await mappingReady.wait();

    // Push the reply.
    notifIter.push(mockNotification(sid, 'agent reply'));
    // Must stop all iterators so all loops can exit.
    cloudMessagesIter.stop();
    notifIter.stop();
    proactiveIter.stop();

    await runPromise;

    // L1 verified: prompt was called with correct content.
    expect(promptImpl).toHaveBeenCalledWith(sid, [
      { type: 'text', text: 'round-trip test' },
    ]);

    // L2 verified: cloud.send was called with the reply content.
    expect(cloudSendMock).toHaveBeenCalledWith(chat, {
      type: 'text',
      text: 'agent reply',
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Bridge.run() lifecycle and close() behaviour
  // ══════════════════════════════════════════════════════════════════════════

  it('bridge.run() resolves when all loops end cleanly', async () => {
    const chat = channelId('chat-clean');
    router.register(agentId('agent-clean'), [chat]);

    acpGetOrCreateSessionMock.mockResolvedValue(sessionId('sid-clean'));
    cloudMessagesIter.push(mockMessage(chat, 'cleanup trigger'));
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await expect(bridge.run()).resolves.toBeUndefined();
  });

  // bridge.close() aborts without hanging — covered by existing
  // bridge/index.test.ts "close() terminates the cloud-messages loop".
  // The AcpSession abort signal depends on the listener being registered before
  // close() fires, which is sensitive to JS event-loop timing in the test env.

  it('bridge.run() is idempotent — second call returns early', async () => {
    const chat = channelId('chat-idempotent');
    router.register(agentId('agent-idem'), [chat]);
    acpGetOrCreateSessionMock.mockResolvedValue(sessionId('sid-idem'));
    cloudMessagesIter.push(mockMessage(chat, 'first'));
    cloudMessagesIter.stop();
    acpNotificationsIter.stop();
    acpProactiveIter.stop();

    bridge = makeBridge();
    await bridge.run();
    await expect(bridge.run()).resolves.toBeUndefined(); // second call is no-op
  });

  // ══════════════════════════════════════════════════════════════════════════
  // L4 — downstream-initiated send (sendMessage stub / not yet implemented)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Bridge currently has no downstream.send_message handler.
  // This test is a placeholder documenting the expected interface.
  // After the feature is implemented, replace this placeholder with a real
  // integration test covering:
  //   downstream send_message → Bridge → cloud.send()
  //
  // it('L4: downstream-initiated message reaches cloud.send()', async () => { ... })

  it('L4: PLACEHOLDER — downstream send_message not yet implemented in Bridge', () => {
    // Bridge currently exposes no `sendMessage` or equivalent method.
    // The ACP protocol for downstream-initiated sending is described in:
    //   https://github.com/.../agent-client-protocol
    // Once implemented, add test here.
    expect(true).toBe(true);
  });
});

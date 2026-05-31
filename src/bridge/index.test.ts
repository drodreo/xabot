import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from './index.js';
import { channelId, messageId, userId, type ChannelId, type Message } from '../core/types.js';
import type { XacppTransport, XacppSession, XacppResponse } from 'xacpp';

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
    return { [Symbol.asyncIterator]: function (): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (self.queue.length > 0) {
            return { value: self.queue.shift()!, done: false };
          }
          if (self.stopped) {
            return { value: undefined as never, done: true };
          }
          return new Promise<IteratorResult<T>>((r) => { self.waiting = r; });
        },
      };
    } };
  }
}

function mockTransport(): XacppTransport {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ kind: 'acknowledge' }),
    onRequest: vi.fn(),
  } as unknown as XacppTransport;
}

function mockSession(requestCommand: ReturnType<typeof vi.fn>, credentials: string = 'chat-a'): XacppSession {
  return {
    sessionId: 'sess-1',
    credentials,
    requestCommand,
  } as unknown as XacppSession;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge', () => {
  let bridge: Bridge;
  const cloudSend = vi.fn<(chatId: ChannelId, content: { type: string; text: string }) => Promise<ReturnType<typeof messageId>>>();
  const cloudClose = vi.fn<() => Promise<void>>();
  const sessionRequestCommand = vi.fn<(command: any) => Promise<XacppResponse>>();
  const transportDisconnect = vi.fn<() => Promise<void>>();
  let cloudMessagesIter: ManualIter<Message>;

  beforeEach(() => {
    vi.clearAllMocks();
    cloudMessagesIter = new ManualIter<Message>();
    cloudSend.mockResolvedValue(messageId('mid-1'));
    cloudClose.mockResolvedValue(undefined);
    sessionRequestCommand.mockReset();
    transportDisconnect.mockResolvedValue(undefined);

    const transport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: transportDisconnect,
      send: vi.fn(),
      onRequest: vi.fn(),
    } as unknown as XacppTransport;

    bridge = new Bridge(
      transport,
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          setTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── close() ─────────────────────────────────────────────────────────────

  it('close() is idempotent', async () => {
    await bridge.close();
    await bridge.close();
    expect(cloudClose).toHaveBeenCalledTimes(1);
    expect(transportDisconnect).toHaveBeenCalledTimes(1);
  });

  // ── Cloud → Agent ───────────────────────────────────────────────────────

  it('cloud message triggers new_activity then invoke_activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'hello agent'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(3);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
      invoke_activity: { activity: 'act-1', messages: [{ type: 'text', text: 'hello agent' }] },
    });
  });

  it('second cloud message reuses existing activityId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'first'));
    cloudMessagesIter.push(msg(chatA, 'second'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(4);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(4, {
      invoke_activity: { activity: 'act-1', messages: [{ type: 'text', text: 'second' }] },
    });
  });

  it('cloud messages without session are discarded', async () => {
    cloudMessagesIter.push(msg(channelId('chat-a'), 'hello'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).not.toHaveBeenCalled();
  });

  it('inbound image with localUri is buffered and merged with text', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push({
      id: messageId('msg-1'),
      chatId: chatA,
      senderId: userId('u1'),
      content: { type: 'image', source: { localUri: '/tmp/xabot_img.png', remoteUrl: 'https://example.com/img.png', sha256: 'deadbeef0000', sizeBytes: 12345, mimeType: 'image/png', requireOrganized: true } },
      direction: 'incoming',
    });
    cloudMessagesIter.push(msg(chatA, 'describe this'));
    cloudMessagesIter.stop();

    await bridge.run();

    const invokeCall = sessionRequestCommand.mock.calls.find(
      (c) => typeof c[0] === 'object' && 'invoke_activity' in c[0],
    );
    expect(invokeCall).toBeTruthy();
    const messages = (invokeCall![0] as any).invoke_activity.messages;
    expect(messages[0].type).toBe('image');
    expect(messages[0].source.localUri).toBe('/tmp/xabot_img.png');
    expect(messages[0].source.sha256).toBe('deadbeef0000');
    expect(messages[0].source.sizeBytes).toBe(12345);
    expect(messages[0].source.requireOrganized).toBe(true);
    expect(messages[0].source.remoteUrl).toBe('https://example.com/img.png');
    expect(messages[1]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('inbound file with localUri is buffered and merged with text', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push({
      id: messageId('msg-1'),
      chatId: chatA,
      senderId: userId('u1'),
      content: { type: 'file', source: { localUri: '/tmp/xabot_doc.pdf', remoteUrl: 'https://example.com/doc.pdf', sha256: 'cafebabe1111', sizeBytes: 67890, mimeType: 'application/pdf', requireOrganized: true } },
      direction: 'incoming',
    });
    cloudMessagesIter.push(msg(chatA, 'summarize'));
    cloudMessagesIter.stop();

    await bridge.run();

    const invokeCall = sessionRequestCommand.mock.calls.find(
      (c) => typeof c[0] === 'object' && 'invoke_activity' in c[0],
    );
    expect(invokeCall).toBeTruthy();
    const messages = (invokeCall![0] as any).invoke_activity.messages;
    expect(messages[0].type).toBe('file');
    expect(messages[0].source.localUri).toBe('/tmp/xabot_doc.pdf');
    expect(messages[0].source.sha256).toBe('cafebabe1111');
    expect(messages[0].source.sizeBytes).toBe(67890);
    expect(messages[0].source.requireOrganized).toBe(true);
    expect(messages[0].source.remoteUrl).toBe('https://example.com/doc.pdf');
    expect(messages[1]).toEqual({ type: 'text', text: 'summarize' });
  });

  it('fallback text is buffered and merged with text invoke', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push({
      id: messageId('msg-1'),
      chatId: chatA,
      senderId: userId('u1'),
      content: { type: 'text', text: '[图片接收失败：network down]' },
      direction: 'incoming',
      fallback: true,
    } as any);
    cloudMessagesIter.push(msg(chatA, 'try another'));
    cloudMessagesIter.stop();

    await bridge.run();

    const invokeCall = sessionRequestCommand.mock.calls.find(
      (c) => typeof c[0] === 'object' && 'invoke_activity' in c[0],
    );
    expect(invokeCall).toBeTruthy();
    const messages = (invokeCall![0] as any).invoke_activity.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', text: '[图片接收失败：network down]' });
    expect(messages[1]).toEqual({ type: 'text', text: 'try another' });
  });

  it('last_activity returns activity_ready → no new_activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-last', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'hello'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, {
      invoke_activity: { activity: 'act-last', messages: [{ type: 'text', text: 'hello' }] },
    });
    // new_activity was never called
    const newActivityCalls = sessionRequestCommand.mock.calls.filter(
      (call) => typeof call[0] === 'object' && 'new_activity' in call[0],
    );
    expect(newActivityCalls).toHaveLength(0);
  });

  it('last_activity returns activity_not_found → falls back to new_activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-new', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'hello'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(3);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
      invoke_activity: { activity: 'act-new', messages: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('cached activityId → skips both last_activity and new_activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-cached', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'first'));
    cloudMessagesIter.push(msg(chatA, 'second'));
    cloudMessagesIter.stop();

    await bridge.run();

    // last_activity + new_activity for first msg, invoke for both
    expect(sessionRequestCommand).toHaveBeenCalledTimes(4);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
      invoke_activity: { activity: 'act-cached', messages: [{ type: 'text', text: 'first' }] },
    });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(4, {
      invoke_activity: { activity: 'act-cached', messages: [{ type: 'text', text: 'second' }] },
    });
  });

  it('/new clears chatToActivity and creates new activity without invoke', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-old', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-new', agent: 'test' });

    cloudMessagesIter.push(msg(chatA, 'first'));
    cloudMessagesIter.push(msg(chatA, '/new'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(4);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
      invoke_activity: { activity: 'act-old', messages: [{ type: 'text', text: 'first' }] },
    });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(4, { new_activity: { title: '' } });
  });

  it('/new 你好 creates activity then invokes with prompt', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-new', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, '/new 你好'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, {
      invoke_activity: { activity: 'act-new', messages: [{ type: 'text', text: '你好' }] },
    });
  });

  it('/compact sends compact_activity for cached activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-cached', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'first'));
    cloudMessagesIter.push(msg(chatA, '/compact'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(4);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
      invoke_activity: { activity: 'act-cached', messages: [{ type: 'text', text: 'first' }] },
    });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(4, {
      compact_activity: { activity: 'act-cached' },
    });
  });

  it('/compact without cached activityId and last_activity not_found skips', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand.mockResolvedValueOnce({ kind: 'activity_not_found' });

    cloudMessagesIter.push(msg(chatA, '/compact'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(1);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
  });

  it('/compact without cache falls back to last_activity then sends compact_activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-last', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, '/compact'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, {
      compact_activity: { activity: 'act-last' },
    });
  });

  it('/compact without cache and last_activity not_found sends prompt to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand.mockResolvedValueOnce({ kind: 'activity_not_found' });
    cloudSend.mockResolvedValue(messageId('mid-1'));

    cloudMessagesIter.push(msg(chatA, '/compact'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(1);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: '当前暂无活动中的对话' });
  });

  it('/cancel without cache falls back to last_activity then sends cancel_activity', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-last', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, '/cancel'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, {
      cancel_activity: { activity: 'act-last' },
    });
  });

  it('/cancel without cache and last_activity not_found sends prompt to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand.mockResolvedValueOnce({ kind: 'activity_not_found' });
    cloudSend.mockResolvedValue(messageId('mid-1'));

    cloudMessagesIter.push(msg(chatA, '/cancel'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(1);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: '当前暂无活动中的对话' });
  });

  it('/comapct typo sends unknown command hint to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();
    cloudSend.mockResolvedValue(messageId('mid-1'));

    cloudMessagesIter.push(msg(chatA, '/comapct'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).not.toHaveBeenCalled();
    expect(cloudSend).toHaveBeenCalledWith(chatA, {
      type: 'text',
      text: '未知命令: /comapct，支持的命令: /new, /compact, /cancel',
    });
  });

  // ── Agent → Cloud (via handleEvent) ─────────────────────────────────────
  // The chatId↔activityId mapping is established through the run() path.
  // For handleEvent tests, we pre-populate by running a cloud message first.

  it('handleEvent content_delta sends text to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_delta',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'Hello ' },
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Hello ' });
  });

  it('handleEvent content_part forwards to cloud regardless of stream capability', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test content_part forwarding
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn().mockReturnValue(false),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    // Mock NonStreaming capability — content_part should still be forwarded
    (verboseBridge as any).cloud = {
      ...((verboseBridge as any).cloud),
      streamCapability: () => StreamCapability.NonStreaming,
    };

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_part',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'Intermediate result' },
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Intermediate result' });
  });

  it('handleEvent complete returns acknowledge without sending (content_part already forwarded)', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to ensure content_part forwarding behavior
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    const response = await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'complete',
        assistantReply: [{ type: 'text', text: 'Final answer' }],
      },
    });

    expect(response).toEqual({ kind: 'acknowledge' });
    // complete always sends assistantReply via _sendContentPart
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Final answer' });
  });

  it('handleEvent notify sends message to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'notify',
        requestId: 'req-1',
        message: 'Heads up!',
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Heads up!' });
  });

  it('handleEvent info sends prefixed message to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'info', title: 't', content: 'info msg' },
    } as any);

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'ℹ️ t\ninfo msg' });
  });

  it('handleEvent warn sends prefixed message to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'warn', title: 't', content: 'warn msg' },
    } as any);

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: '⚠️ t\nwarn msg' });
  });

  it('handleEvent error sends prefixed message to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'error', title: 't', content: 'error msg' },
    } as any);

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: '❌ t\nerror msg' });
  });

  it('handleEvent without sessionChatId returns acknowledge without sending', async () => {
    await bridge.handleEvent('any-act', {
      activity: 'any-act',
      event: {
        type: 'content_delta',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'orphan' },
      },
    });

    expect(cloudSend).not.toHaveBeenCalled();
  });

  // ── Pending response ────────────────────────────────────────────────────

  it('resolvePending resolves a blocked action_request', async () => {
    const actionBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    actionBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    actionBridge.markEstablished();
    (actionBridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const eventPromise = actionBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-1',
        toolName: 'test_tool',
        arguments: '{}',
        actionId: 'action-1',
        description: 'Test action',
        alert: 'info',
      },
    });

    // cloudSend called with the action request notification
    await vi.waitFor(() => expect(cloudSend).toHaveBeenCalled());

    actionBridge.resolvePending('req-1', { kind: 'action', requestId: 'req-1', type: 'approve' });

    const response = await eventPromise;
    expect(response).toEqual({ kind: 'action', requestId: 'req-1', type: 'approve' });
  });

  it('resolvePending resolves a blocked question', async () => {
    const questionBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    questionBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    questionBridge.markEstablished();
    (questionBridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const eventPromise = questionBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'question',
        requestId: 'req-q1',
        question: 'What is your name?',
        options: ['Alice', 'Bob'],
      },
    });

    await vi.waitFor(() => expect(cloudSend).toHaveBeenCalled());

    questionBridge.resolvePending('req-q1', { kind: 'question', requestId: 'req-q1', type: 'answer', content: 'Alice' });

    const response = await eventPromise;
    expect(response).toEqual({ kind: 'question', requestId: 'req-q1', type: 'answer', content: 'Alice' });
  });

  // ── close() rejects pending ─────────────────────────────────────────────

  it('close() rejects pending responses', async () => {
    const closeBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    closeBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    closeBridge.markEstablished();
    (closeBridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const eventPromise = closeBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-1',
        toolName: 'test_tool',
        arguments: '{}',
        actionId: 'action-1',
        description: 'Test action',
        alert: 'info',
      },
    });

    await vi.waitFor(() => expect(cloudSend).toHaveBeenCalled());

    await closeBridge.close();

    const response = await eventPromise;
    expect(response.kind).toBe('error');
  });

  // ── handleCommand ───────────────────────────────────────────────────────

  it('handleCommand returns acknowledge', async () => {
    const response = await bridge.handleCommand({ new_activity: { title: null } });
    expect(response).toEqual({ kind: 'acknowledge' });
  });

  it('handleCommand message sends content to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));

    const response = await bridge.handleCommand({
      message: {
        content: [
          { type: 'text', text: 'hello from agent' },
          { type: 'image', source: { remoteUrl: 'https://example.com/img.png', localUri: '', mimeType: 'image/png', sizeBytes: 100 } },
        ],
      },
    });

    expect(response).toEqual({ kind: 'acknowledge' });
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'hello from agent' });
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'image', source: { localUri: '', remoteUrl: 'https://example.com/img.png', mimeType: 'image/png', sizeBytes: 100 } });
  });

  it('handleCommand message without sessionChatId returns acknowledge', async () => {
    const response = await bridge.handleCommand({
      message: { content: [{ type: 'text', text: 'orphan' }] },
    });
    expect(response).toEqual({ kind: 'acknowledge' });
    expect(cloudSend).not.toHaveBeenCalled();
  });

  // ── Problem 4: non-text ContentPart handling ────────────────────────────

  it('handleEvent content_delta with image sends image to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_delta',
        round: 'r1',
        pair: 'p1',
        payload: {
          type: 'image',
          source: { remoteUrl: 'https://example.com/img.png', localUri: '', mimeType: 'image/png', sizeBytes: 100 },
        },
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'image', source: { localUri: '', remoteUrl: 'https://example.com/img.png', mimeType: 'image/png', sizeBytes: 100 } });
  });

  it('handleEvent complete with image returns acknowledge without sending', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to ensure content_part forwarding behavior
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    const response = await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'complete',
        assistantReply: [
          { type: 'text', text: 'Here is the image:' },
          { type: 'image', source: { remoteUrl: 'https://example.com/result.png', localUri: '', mimeType: 'image/png', sizeBytes: 200 } },
        ],
      },
    });

    expect(response).toEqual({ kind: 'acknowledge' });
    // complete always sends assistantReply via _sendContentPart
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Here is the image:' });
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'image', source: { remoteUrl: 'https://example.com/result.png', localUri: '', mimeType: 'image/png', sizeBytes: 200 } });
  });

  // ── Problem 5: cloud.send failure cleans up pending ─────────────────────

  it('action_request: cloud.send failure returns error and cleans pending', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    // Make cloud.send reject on the next call
    cloudSend.mockRejectedValueOnce(new Error('cloud unavailable'));

    const response = await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-fail',
        toolName: 'test_tool',
        arguments: '{}',
        actionId: 'action-1',
        description: 'Test action',
        alert: 'info',
      },
    });

    // Should return error response, not hang
    expect(response).toEqual({ kind: 'error', code: 'send_failed', message: 'failed to forward action_request to cloud' });

    // Pending should be cleaned up — resolving after failure should be a no-op
    bridge.resolvePending('req-fail', { kind: 'action', requestId: 'req-fail', type: 'approve' });
    // No unhandled rejection
  });

  it('question: cloud.send failure returns error and cleans pending', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    cloudSend.mockRejectedValueOnce(new Error('cloud unavailable'));

    const response = await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'question',
        requestId: 'req-q-fail',
        question: 'What?',
        options: ['A', 'B'],
      },
    });

    expect(response).toEqual({ kind: 'error', code: 'send_failed', message: 'failed to forward question to cloud' });
  });

  // ── Problem 3: end-to-end chain test ────────────────────────────────────

  it('E2E: cloud msg → new_activity → invoke_activity → content_delta → cloud.send', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    // Cloud message arrives → last_activity → activity_not_found → new_activity + invoke_activity
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-e2e', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'hello'));
    cloudMessagesIter.stop();
    await bridge.run();

    // Verify cloud→agent path
    expect(sessionRequestCommand).toHaveBeenCalledTimes(3);

    // Agent responds with content_delta
    await bridge.handleEvent('act-e2e', {
      activity: 'act-e2e',
      event: {
        type: 'content_delta',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'Hi there!' },
      },
    });

    // Verify agent→cloud path via sessionChatId
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Hi there!' });
  });

  it('E2E: cloud msg → invoke → content_part forwarded, complete returns acknowledge', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test content_part forwarding
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          setTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-e2e2', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'ping'));
    cloudMessagesIter.stop();
    await verboseBridge.run();

    // Agent sends content_part — should be forwarded
    await verboseBridge.handleEvent('act-e2e2', {
      activity: 'act-e2e2',
      event: {
        type: 'content_part',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'pong' },
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'pong' });

    // Agent sends complete — complete always sends assistantReply via _sendContentPart
    const response = await verboseBridge.handleEvent('act-e2e2', {
      activity: 'act-e2e2',
      event: {
        type: 'complete',
        assistantReply: [{ type: 'text', text: 'pong' }],
      },
    });

    expect(response).toEqual({ kind: 'acknowledge' });
    // Complete sends the assistantReply again
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'pong' });
  });

  it('E2E: same chatId multiple messages → activity reused, events routed to sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-a', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'first'));
    cloudMessagesIter.push(msg(chatA, 'second'));
    cloudMessagesIter.stop();
    await bridge.run();

    // Only one new_activity for the same chatId
    expect(sessionRequestCommand).toHaveBeenCalledTimes(4);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });

    // Outbound events route to sessionChatId
    await bridge.handleEvent('act-a', {
      activity: 'act-a',
      event: {
        type: 'content_delta', round: 'r1', pair: 'p1',
        payload: { type: 'text', text: 'reply' },
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'reply' });
  });

  it('replaceCloud swaps the underlying PlatformClient', async () => {
    const newCloud = {
      platform: 'wechat',
      send: vi.fn().mockResolvedValue(undefined),
      messages: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: async function* () {} }),
      streamCapability: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../core/client.js').PlatformClient;

    bridge.replaceCloud(newCloud);

    bridge.setSession(mockSession(sessionRequestCommand, 'chat-1'));
    bridge.markEstablished();
    await bridge.handleCommand({
      message: { content: [{ type: 'text', text: 'hello' }] },
    } as any);

    expect(newCloud.send).toHaveBeenCalledWith('chat-1', { type: 'text', text: 'hello' });
  });

  it('setSession with JSON credentials extracts chatId field', () => {
    const session = mockSession(sessionRequestCommand, JSON.stringify({ botToken: 't', baseUrl: 'u', chatId: 'wx_chat_123' }));
    bridge.setSession(session);
    expect((bridge as any).sessionChatId).toBe('wx_chat_123');
  });

  it('setSession with plain string credentials uses raw value', () => {
    const session = mockSession(sessionRequestCommand, 'och_456');
    bridge.setSession(session);
    expect((bridge as any).sessionChatId).toBe('och_456');
  });

  it('constructs without cloud, replaceCloud enables message consumption', async () => {
    const transport = mockTransport();
    const b = new Bridge(transport);

    const newCloudSend = vi.fn().mockResolvedValue(messageId('mid-1'));
    const newCloud = {
      platform: 'mock',
      connect: vi.fn().mockResolvedValue(undefined),
      send: newCloudSend,
      messages: () => cloudMessagesIter.iter(),
      streamCapability: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;

    b.replaceCloud(newCloud as never);
    b.setSession(mockSession(sessionRequestCommand));
    b.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(channelId('chat-a'), 'delayed hello'));
    cloudMessagesIter.stop();

    await b.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(3);
  });

  it('constructs without cloud, close during wait exits run safely', async () => {
    const transport = mockTransport();
    const b = new Bridge(transport);

    // close before replaceCloud — run() should exit without error
    const runPromise = b.run();
    await b.close();
    await runPromise;

    expect(sessionRequestCommand).not.toHaveBeenCalled();
  });

  // ── Pending queue behavior ──────────────────────────────────────────────

  it('queue: second action_request queues without cloud.send', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    cloudSend.mockClear();
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const p1 = bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-1',
        toolName: 'bash',
        arguments: '',
        actionId: 'a1',
        description: 'test',
        alert: 'info',
      },
    });

    // First call sent message to cloud
    await vi.waitFor(() => expect(cloudSend).toHaveBeenCalledTimes(1));

    const p2 = bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-2',
        toolName: 'bash',
        arguments: '',
        actionId: 'a2',
        description: 'test2',
        alert: 'info',
      },
    });

    // Second call did NOT send (queued)
    expect(cloudSend).toHaveBeenCalledTimes(1);

    // Resolve first — should drive queue and send second
    bridge.resolvePending('req-1', { kind: 'action', requestId: 'req-1', type: 'approve' });

    const r1 = await p1;
    expect(r1).toEqual({ kind: 'action', requestId: 'req-1', type: 'approve' });

    // Queue drive sends second message
    expect(cloudSend).toHaveBeenCalledTimes(2);

    bridge.resolvePending('req-2', { kind: 'action', requestId: 'req-2', type: 'approve' });
    const r2 = await p2;
    expect(r2).toEqual({ kind: 'action', requestId: 'req-2', type: 'approve' });
  });

  it('queue: different targetKeys do not interfere', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    cloudSend.mockClear();
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');
    (bridge as any).bindActivity(channelId('chat-b'), userId('u2'), 'act-2');

    const p1 = bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-a',
        toolName: 'bash',
        arguments: '',
        actionId: 'a1',
        description: 'test',
        alert: 'info',
      },
    });
    const p2 = bridge.handleEvent('act-2', {
      activity: 'act-2',
      event: {
        type: 'action_request',
        requestId: 'req-b',
        toolName: 'bash',
        arguments: '',
        actionId: 'a2',
        description: 'test',
        alert: 'info',
      },
    });

    // Both sent immediately (different targets)
    await vi.waitFor(() => expect(cloudSend).toHaveBeenCalledTimes(2));

    bridge.resolvePending('req-a', { kind: 'action', requestId: 'req-a', type: 'approve' });
    bridge.resolvePending('req-b', { kind: 'action', requestId: 'req-b', type: 'reject', reason: 'no' });

    expect(await p1).toEqual({ kind: 'action', requestId: 'req-a', type: 'approve' });
    expect(await p2).toEqual({ kind: 'action', requestId: 'req-b', type: 'reject', reason: 'no' });
  });

  // ── tryParsePendingResponse coverage ────────────────────────────────────

  it('tryParsePendingResponse action_request a/y/n/t', async () => {
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const event: any = {
      type: 'action_request',
      requestId: 'req-1',
      toolName: 'bash',
      arguments: '',
      actionId: 'a1',
      description: 'test',
      alert: 'info',
    };
    const item = (bridge as any).createPendingItem(channelId('chat-a'), userId('u1'), 'action_request', event);

    expect((bridge as any).tryParsePendingResponse(item, 'a')).toEqual({ kind: 'action', requestId: 'req-1', type: 'approve_always' });
    expect((bridge as any).tryParsePendingResponse(item, 'y')).toEqual({ kind: 'action', requestId: 'req-1', type: 'approve' });
    expect((bridge as any).tryParsePendingResponse(item, 'n')).toEqual({ kind: 'action', requestId: 'req-1', type: 'reject', reason: '用户拒绝' });
    expect((bridge as any).tryParsePendingResponse(item, 'n 太危险了')).toEqual({ kind: 'action', requestId: 'req-1', type: 'reject', reason: '太危险了' });
    expect((bridge as any).tryParsePendingResponse(item, 'c')).toEqual({ kind: 'action', requestId: 'req-1', type: 'reject', reason: '用户取消执行' });
    expect((bridge as any).tryParsePendingResponse(item, 'invalid')).toBeNull();
  });

  it('tryParsePendingResponse question numeric option and free text', async () => {
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const event: any = {
      type: 'question',
      requestId: 'req-1',
      question: 'Choose?',
      options: ['A', 'B', 'C'],
    };
    const item = (bridge as any).createPendingItem(channelId('chat-a'), userId('u1'), 'question', event);

    expect((bridge as any).tryParsePendingResponse(item, '2')).toEqual({ kind: 'question', requestId: 'req-1', type: 'answer', content: 'B' });
    expect((bridge as any).tryParsePendingResponse(item, 'c')).toEqual({ kind: 'question', requestId: 'req-1', type: 'skip', reason: '用户取消执行' });
    // n is no longer a skip command — treated as free text answer
    expect((bridge as any).tryParsePendingResponse(item, 'n')).toEqual({ kind: 'question', requestId: 'req-1', type: 'answer', content: 'n' });
    expect((bridge as any).tryParsePendingResponse(item, 'no thanks')).toEqual({ kind: 'question', requestId: 'req-1', type: 'answer', content: 'no thanks' });
    expect((bridge as any).tryParsePendingResponse(item, 'free answer')).toEqual({ kind: 'question', requestId: 'req-1', type: 'answer', content: 'free answer' });

    // Out of range numeric
    expect((bridge as any).tryParsePendingResponse(item, '99')).toEqual({ kind: 'question', requestId: 'req-1', type: 'answer', content: '99' });
  });

  it('tryParsePendingResponse sensitive_info_operation collect and cancel', async () => {
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const event: any = {
      type: 'sensitive_info_operation',
      requestId: 'req-1',
      operation: {
        type: 'collect',
        items: [
          { key: 'K1', displayText: 'Key1', hint: '', siType: 'secret' },
          { key: 'K2', displayText: 'Key2', hint: '', siType: 'env_var' },
        ],
      },
    };
    const item = (bridge as any).createPendingItem(channelId('chat-a'), userId('u1'), 'sensitive_info_operation', event);

    const result = (bridge as any).tryParsePendingResponse(item, 'val1\nval2');
    expect(result?.kind).toBe('sensitive_info_operation');
    expect(result?.results).toEqual([
      { type: 'provided', key: 'K1', value: 'val1' },
      { type: 'provided', key: 'K2', value: 'val2' },
    ]);

    const cancelResult = (bridge as any).tryParsePendingResponse(item, 'c');
    expect(cancelResult?.results).toEqual([
      { type: 'collect_skipped', key: 'K1', reason: '用户取消执行' },
      { type: 'collect_skipped', key: 'K2', reason: '用户取消执行' },
    ]);
  });

  it('tryParsePendingResponse sensitive_info_operation delete', async () => {
    (bridge as any).bindActivity(channelId('chat-a'), userId('u1'), 'act-1');

    const event: any = {
      type: 'sensitive_info_operation',
      requestId: 'req-1',
      operation: {
        type: 'delete',
        items: [
          { key: 'K1', displayText: 'Key1', id: 'id1', siType: 'secret' },
        ],
      },
    };
    const item = (bridge as any).createPendingItem(channelId('chat-a'), userId('u1'), 'sensitive_info_operation', event);

    const result = (bridge as any).tryParsePendingResponse(item, 'y');
    expect(result?.results).toEqual([{ type: 'deleted', id: 'id1' }]);
  });

  // ── Thinking and tool-use indicators ────────────────────────────────────

  it('first think event sends thinking indicator', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test thinking indicator
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'think', requestId: 't1' },
    } as any);

    const thinkCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('正在思考'));
    expect(thinkCall).toBeTruthy();
  });

  it('consecutive think events do not repeat indicator', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test thinking indicator
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'think', requestId: 't1' },
    } as any);
    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'think', requestId: 't2' },
    } as any);

    const thinkCalls = cloudSend.mock.calls.filter((c) => c[1]?.type === 'text' && c[1]?.text?.includes('正在思考'));
    expect(thinkCalls).toHaveLength(1);
  });

  it('think then content_part ends thinking and forwards content', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test thinking indicator
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'think', requestId: 't1' },
    } as any);

    cloudSend.mockClear();

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_part',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'result' },
      },
    });

    const contentCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text === 'result');
    expect(contentCall).toBeTruthy();
    const endThinkCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('思考用时'));
    expect(endThinkCall).toBeFalsy();
  });

  it('think then tool_use ends thinking and starts tool indicator', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test thinking/tool indicator
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'think', requestId: 't1' },
    } as any);

    cloudSend.mockClear();

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'tool_use', requestId: 'tu1', toolName: 'bash', arguments: '{}' },
    } as any);

    const endThinkCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('思考用时'));
    expect(endThinkCall).toBeFalsy();
    const toolCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('行动中'));
    expect(toolCall).toBeTruthy();
  });

  it('first tool_use event sends tool indicator', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test tool indicator
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'tool_use', requestId: 'tu1', toolName: 'bash', arguments: '{}' },
    } as any);

    const toolCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('行动中'));
    expect(toolCall).toBeTruthy();
  });

  it('consecutive tool_use events do not repeat indicator', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test tool indicator
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'tool_use', requestId: 'tu1', toolName: 'bash', arguments: '{}' },
    } as any);
    await verboseBridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'tool_use', requestId: 'tu2', toolName: 'bash', arguments: '{}' },
    } as any);

    const toolCalls = cloudSend.mock.calls.filter((c) => c[1]?.type === 'text' && c[1]?.text?.includes('行动中'));
    expect(toolCalls).toHaveLength(1);
  });

  it('pair_complete does not send tool duration indicator', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'tool_use', requestId: 'tu1', toolName: 'bash', arguments: '{}' },
    } as any);

    cloudSend.mockClear();

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'pair_complete', round: 'r1', pair: 'p1' },
    } as any);

    const completeCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('行动用时'));
    expect(completeCall).toBeFalsy();
  });

  it('pair_complete without tool_use does not send duration', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'pair_complete', round: 'r1', pair: 'p1' },
    } as any);

    const completeCall = cloudSend.mock.calls.find((c) => c[1]?.type === 'text' && c[1]?.text?.includes('行动用时'));
    expect(completeCall).toBeFalsy();
  });

  it('full ReAct cycle: think → tool_use → pair_complete → complete', async () => {
    const chatA = channelId('chat-a');
    // Create bridge with verbose:true to test ReAct cycle indicators
    const verboseBridge = new Bridge(
      mockTransport(),
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          beginProcessing: vi.fn().mockResolvedValue(undefined),
          endProcessing: vi.fn().mockResolvedValue(undefined),
          close: cloudClose,
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
        verbose: true,
      },
    );
    verboseBridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    verboseBridge.markEstablished();
    (verboseBridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    await verboseBridge.handleEvent('act-1', { activity: 'act-1', event: { type: 'think', requestId: 't1' } } as any);
    await verboseBridge.handleEvent('act-1', { activity: 'act-1', event: { type: 'tool_use', requestId: 'tu1', toolName: 'bash', arguments: '{}' } } as any);
    await verboseBridge.handleEvent('act-1', { activity: 'act-1', event: { type: 'pair_complete', round: 'r1', pair: 'p1' } } as any);
    await verboseBridge.handleEvent('act-1', { activity: 'act-1', event: { type: 'complete', assistantReply: [{ type: 'text', text: 'done' }] } });

    const texts = cloudSend.mock.calls
      .filter((c) => c[1]?.type === 'text')
      .map((c) => c[1].text);

    expect(texts.some((t: string) => t.includes('正在思考'))).toBe(true);
    expect(texts.some((t: string) => t.includes('思考用时'))).toBe(false);
    expect(texts.some((t: string) => t.includes('行动中'))).toBe(true);
    expect(texts.some((t: string) => t.includes('行动用时'))).toBe(false);
  });

  it('processing indicator lifecycle: begin on invoke, end on complete', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();
    (bridge as any).bindActivity(chatA, userId('u1'), 'act-1');

    sessionRequestCommand.mockResolvedValue({ kind: 'acknowledge' });
    cloudMessagesIter.push(msg(chatA, 'hello'));
    cloudMessagesIter.stop();
    await bridge.run();

    expect((bridge as any).cloud.setTypingIndicator).toHaveBeenCalled();

    (bridge as any).cloud.releaseTypingIndicator.mockClear();

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'complete', assistantReply: [{ type: 'text', text: 'done' }] },
    });

    expect((bridge as any).cloud.releaseTypingIndicator).toHaveBeenCalled();
  });
});

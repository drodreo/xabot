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
      {
        platform: 'mock',
        connect: vi.fn().mockResolvedValue(undefined),
        send: cloudSend,
        messages: () => cloudMessagesIter.iter(),
        streamCapability: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(undefined),
        close: cloudClose,
      } as never,
      transport,
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

  it('image content is converted to ContentPart', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push({
      id: messageId('msg-1'),
      chatId: chatA,
      senderId: userId('u1'),
      content: { type: 'image', url: 'https://example.com/img.png' },
      direction: 'incoming',
    });
    cloudMessagesIter.stop();

    await bridge.run();

    const invokeCall = sessionRequestCommand.mock.calls[2]![0] as any;
    expect(invokeCall.invoke_activity.messages[0].type).toBe('image');
    expect(invokeCall.invoke_activity.messages[0].source.remoteUrl).toBe('https://example.com/img.png');
  });

  it('file content is converted to text ContentPart', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push({
      id: messageId('msg-1'),
      chatId: chatA,
      senderId: userId('u1'),
      content: { type: 'file', url: 'https://example.com/doc.pdf', name: 'doc.pdf' },
      direction: 'incoming',
    });
    cloudMessagesIter.stop();

    await bridge.run();

    const invokeCall = sessionRequestCommand.mock.calls[2]![0] as any;
    expect(invokeCall.invoke_activity.messages[0].type).toBe('text');
    expect(invokeCall.invoke_activity.messages[0].text).toBe('[file: doc.pdf]');
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

  it('handleEvent complete sends assistantReply to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'complete',
        assistantReply: [{ type: 'text', text: 'Final answer' }],
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Final answer' });
  });

  it('handleEvent notify sends message to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

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

  it('handleEvent info/warn/error logs but does not send to cloud', async () => {
    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'info', title: 'test', content: 'just info' },
    });

    expect(cloudSend).not.toHaveBeenCalled();
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
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    const eventPromise = bridge.handleEvent('act-1', {
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
    expect(cloudSend).toHaveBeenCalled();

    bridge.resolvePending('req-1', { kind: 'action', requestId: 'req-1', type: 'approve' });

    const response = await eventPromise;
    expect(response).toEqual({ kind: 'action', requestId: 'req-1', type: 'approve' });
  });

  it('resolvePending resolves a blocked question', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    const eventPromise = bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'question',
        requestId: 'req-q1',
        question: 'What is your name?',
        options: ['Alice', 'Bob'],
      },
    });

    bridge.resolvePending('req-q1', { kind: 'question', requestId: 'req-q1', type: 'answer', content: 'Alice' });

    const response = await eventPromise;
    expect(response).toEqual({ kind: 'question', requestId: 'req-q1', type: 'answer', content: 'Alice' });
  });

  // ── close() rejects pending ─────────────────────────────────────────────

  it('close() rejects pending responses', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    const eventPromise = bridge.handleEvent('act-1', {
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

    await bridge.close();

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
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'image', url: 'https://example.com/img.png' });
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

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'image', url: 'https://example.com/img.png' });
  });

  it('handleEvent complete with image in assistantReply sends image to cloud via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'complete',
        assistantReply: [
          { type: 'text', text: 'Here is the image:' },
          { type: 'image', source: { remoteUrl: 'https://example.com/result.png', localUri: '', mimeType: 'image/png', sizeBytes: 200 } },
        ],
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Here is the image:' });
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'image', url: 'https://example.com/result.png' });
  });

  // ── Problem 5: cloud.send failure cleans up pending ─────────────────────

  it('action_request: cloud.send failure returns error and cleans pending', async () => {
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

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

  it('E2E: cloud msg → new_activity → invoke_activity → complete → cloud.send via sessionChatId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand, 'chat-a'));
    bridge.markEstablished();

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-e2e2', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'ping'));
    cloudMessagesIter.stop();
    await bridge.run();

    // Agent completes with final reply
    await bridge.handleEvent('act-e2e2', {
      activity: 'act-e2e2',
      event: {
        type: 'complete',
        assistantReply: [{ type: 'text', text: 'pong' }],
      },
    });

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
});

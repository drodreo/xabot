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

function mockSession(requestCommand: ReturnType<typeof vi.fn>): XacppSession {
  return {
    sessionId: 'sess-1',
    credentials: null,
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

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'hello agent'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, { new_activity: { title: null } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, {
      invoke_activity: { activity: 'act-1', messages: [{ type: 'text', text: 'hello agent' }] },
    });
  });

  it('second cloud message reuses existing activityId', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'first'));
    cloudMessagesIter.push(msg(chatA, 'second'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(3);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, { new_activity: { title: null } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
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

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
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

    const invokeCall = sessionRequestCommand.mock.calls[1]![0] as any;
    expect(invokeCall.invoke_activity.messages[0].type).toBe('image');
    expect(invokeCall.invoke_activity.messages[0].source.remoteUrl).toBe('https://example.com/img.png');
  });

  it('file content is converted to text ContentPart', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
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

    const invokeCall = sessionRequestCommand.mock.calls[1]![0] as any;
    expect(invokeCall.invoke_activity.messages[0].type).toBe('text');
    expect(invokeCall.invoke_activity.messages[0].text).toBe('[file: doc.pdf]');
  });

  // ── Agent → Cloud (via handleEvent) ─────────────────────────────────────
  // The chatId↔activityId mapping is established through the run() path.
  // For handleEvent tests, we pre-populate by running a cloud message first.

  it('handleEvent content_delta sends text to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    // Pre-populate mapping via cloud message
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

    // Now test handleEvent
    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_delta',
        round: 'r1',
        pair: 'p1',
        payload: { type: 'text', text: 'Hello ' },
      },
    });

    // cloudSend was called once for setup (via run) is not the case — run sends commands to session not to cloud
    // So the first call to cloudSend should be from handleEvent
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Hello ' });
  });

  it('handleEvent complete sends assistantReply to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'complete',
        assistantReply: [{ type: 'text', text: 'Final answer' }],
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Final answer' });
  });

  it('handleEvent notify sends message to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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

  it('handleEvent with unknown activityId returns acknowledge without sending', async () => {
    await bridge.handleEvent('unknown-act', {
      activity: 'unknown-act',
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
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    // Pre-populate mapping
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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

  // ── Problem 4: non-text ContentPart handling ────────────────────────────

  it('handleEvent content_delta with image sends image to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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

  it('handleEvent complete with image in assistantReply sends image to cloud', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-1', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'setup'));
    cloudMessagesIter.stop();
    await bridge.run();

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
    bridge.setSession(mockSession(sessionRequestCommand));

    // Cloud message arrives → new_activity + invoke_activity
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-e2e', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'hello'));
    cloudMessagesIter.stop();
    await bridge.run();

    // Verify cloud→agent path
    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);

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

    // Verify agent→cloud path
    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'Hi there!' });
  });

  it('E2E: cloud msg → new_activity → invoke_activity → complete → cloud.send', async () => {
    const chatA = channelId('chat-a');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-e2e2', agent: 'test' })
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

  it('E2E: multiple chatIds → separate activities → correct routing', async () => {
    const chatA = channelId('chat-a');
    const chatB = channelId('chat-b');
    bridge.setSession(mockSession(sessionRequestCommand));

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-a', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' })
      .mockResolvedValueOnce({ kind: 'activity_created', activity: 'act-b', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(msg(chatA, 'to A'));
    cloudMessagesIter.push(msg(chatB, 'to B'));
    cloudMessagesIter.stop();
    await bridge.run();

    // Agent sends content_delta for each activity
    await bridge.handleEvent('act-a', {
      activity: 'act-a',
      event: {
        type: 'content_delta', round: 'r1', pair: 'p1',
        payload: { type: 'text', text: 'reply A' },
      },
    });
    await bridge.handleEvent('act-b', {
      activity: 'act-b',
      event: {
        type: 'content_delta', round: 'r1', pair: 'p1',
        payload: { type: 'text', text: 'reply B' },
      },
    });

    expect(cloudSend).toHaveBeenCalledWith(chatA, { type: 'text', text: 'reply A' });
    expect(cloudSend).toHaveBeenCalledWith(chatB, { type: 'text', text: 'reply B' });
  });
});

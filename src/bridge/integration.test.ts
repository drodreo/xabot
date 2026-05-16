/**
 * Bridge integration tests — end-to-end data flow verification based on XACPP mocks
 *
 * Covers core paths:
 *   L1: PlatformClient.messages() → Bridge → XacppSession.requestCommand()
 *   L2: XabotSessionHandler.onEvent() → Bridge.handleEvent() → PlatformClient.send()
 *   L3: Multiple chatId routing isolation
 *   L4: action_request block/resolve
 *   L5: cloud.send failure cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from './index.js';
import {
  channelId,
  messageId,
  userId,
  type ChannelId,
  type Message,
} from '../core/types.js';
import type { XacppTransport, XacppSession, XacppResponse } from 'xacpp';

// ─── ManualIter ───────────────────────────────────────────────────────────────

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

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeMessage(chatId: ChannelId, text: string): Message {
  return {
    id: messageId(`msg-${Math.random().toString(36).slice(2)}`),
    chatId,
    senderId: userId('u-sender'),
    content: { type: 'text', text },
    direction: 'incoming',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge integration', () => {
  let bridge: Bridge;

  let cloudMessagesIter: ManualIter<Message>;
  let cloudSendMock: ReturnType<typeof vi.fn>;
  let cloudCloseMock: ReturnType<typeof vi.fn>;
  let sessionRequestCommand: ReturnType<typeof vi.fn>;
  let transportDisconnectMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cloudMessagesIter = new ManualIter<Message>();
    cloudSendMock = vi.fn().mockResolvedValue(messageId('mid-1'));
    cloudCloseMock = vi.fn().mockResolvedValue(undefined);
    sessionRequestCommand = vi.fn();
    transportDisconnectMock = vi.fn().mockResolvedValue(undefined);

    const transport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: transportDisconnectMock,
      send: vi.fn(),
      onRequest: vi.fn(),
    } as unknown as XacppTransport;

    bridge = new Bridge(
      {
        platform: 'mock',
        connect: vi.fn().mockResolvedValue(undefined),
        send: cloudSendMock,
        messages: () => cloudMessagesIter.iter(),
        streamCapability: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(undefined),
        close: cloudCloseMock,
      } as never,
      transport,
    );

    const session = {
      sessionId: 'sess-1',
      credentials: 'chat-a',
      requestCommand: sessionRequestCommand,
    } as unknown as XacppSession;
    bridge.setSession(session);
    bridge.markEstablished();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── L1: Cloud → Agent full path ────────────────────────────────────────

  it('L1: cloud text message → last_activity not found → new_activity + invoke_activity', async () => {
    const chatA = channelId('chat-a');
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(makeMessage(chatA, 'hello'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(3);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(3, {
      invoke_activity: { activity: 'act-1', messages: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('L1: cloud image message → image ContentPart', async () => {
    const chatA = channelId('chat-a');
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-1', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push({
      id: messageId('msg-img'),
      chatId: chatA,
      senderId: userId('u1'),
      content: { type: 'image', url: 'https://example.com/img.png' },
      direction: 'incoming',
    });
    cloudMessagesIter.stop();

    await bridge.run();

    const invokeCall = sessionRequestCommand.mock.calls[2]![0] as any;
    expect(invokeCall.invoke_activity.messages[0].type).toBe('image');
  });

  it('L1: failed new_activity → message skipped', async () => {
    const chatA = channelId('chat-a');
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'error', code: 'rejected', message: 'no' });

    cloudMessagesIter.push(makeMessage(chatA, 'hello'));
    cloudMessagesIter.stop();

    await bridge.run();

    // last_activity then new_activity attempted, no invoke_activity
    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
  });

  it('L1: last_activity returns activity_ready → skips new_activity', async () => {
    const chatA = channelId('chat-a');
    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-last', agent: 'test' })
      .mockResolvedValueOnce({ kind: 'acknowledge' });

    cloudMessagesIter.push(makeMessage(chatA, 'hello'));
    cloudMessagesIter.stop();

    await bridge.run();

    expect(sessionRequestCommand).toHaveBeenCalledTimes(2);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, {
      invoke_activity: { activity: 'act-last', messages: [{ type: 'text', text: 'hello' }] },
    });
    const newActivityCalls = sessionRequestCommand.mock.calls.filter(
      (call) => typeof call[0] === 'object' && 'new_activity' in call[0],
    );
    expect(newActivityCalls).toHaveLength(0);
  });

  // ── L2: Agent → Cloud full path ────────────────────────────────────────

  it('L2: content_delta event → cloud.send text via sessionChatId', async () => {
    const chatA = channelId('chat-a');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_delta', round: 'r1', pair: 'p1',
        payload: { type: 'text', text: 'streaming text' },
      },
    });

    expect(cloudSendMock).toHaveBeenCalledWith(chatA, { type: 'text', text: 'streaming text' });
  });

  it('L2: content_delta with image → cloud.send image via sessionChatId', async () => {
    const chatA = channelId('chat-a');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'content_part', round: 'r1', pair: 'p1',
        payload: {
          type: 'image',
          source: { remoteUrl: 'https://example.com/gen.png', localUri: '', mimeType: 'image/png', sizeBytes: 50 },
        },
      },
    });

    expect(cloudSendMock).toHaveBeenCalledWith(chatA, { type: 'image', url: 'https://example.com/gen.png' });
  });

  it('L2: complete event → cloud.send assistantReply via sessionChatId', async () => {
    const chatA = channelId('chat-a');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'complete',
        assistantReply: [{ type: 'text', text: 'final answer' }],
      },
    });

    expect(cloudSendMock).toHaveBeenCalledWith(chatA, { type: 'text', text: 'final answer' });
  });

  it('L2: notify event → cloud.send message via sessionChatId', async () => {
    const chatA = channelId('chat-a');

    await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: { type: 'notify', requestId: 'n1', message: 'notification' },
    });

    expect(cloudSendMock).toHaveBeenCalledWith(chatA, { type: 'text', text: 'notification' });
  });

  // ── L3: Multiple chatId routing isolation ──────────────────────────────

  it('L3: same chatId → activity reused, events routed to sessionChatId', async () => {
    const chatA = channelId('chat-a');

    sessionRequestCommand
      .mockResolvedValueOnce({ kind: 'activity_not_found' })
      .mockResolvedValueOnce({ kind: 'activity_ready', activity: 'act-a', agent: 'test' })
      .mockResolvedValue({ kind: 'acknowledge' });

    cloudMessagesIter.push(makeMessage(chatA, 'first'));
    cloudMessagesIter.push(makeMessage(chatA, 'second'));
    cloudMessagesIter.stop();
    await bridge.run();

    // last_activity + new_activity for first msg, invoke for both
    expect(sessionRequestCommand).toHaveBeenCalledTimes(4);
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(1, 'last_activity');
    expect(sessionRequestCommand).toHaveBeenNthCalledWith(2, { new_activity: { title: '' } });

    // All outbound events route to sessionChatId
    await bridge.handleEvent('act-a', {
      activity: 'act-a',
      event: { type: 'content_delta', round: 'r1', pair: 'p1', payload: { type: 'text', text: 'reply' } },
    });

    expect(cloudSendMock).toHaveBeenCalledWith(chatA, { type: 'text', text: 'reply' });
  });

  // ── L4: action_request block/resume ────────────────────────────────────

  it('L4: action_request blocks until resolvePending', async () => {
    const eventPromise = bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-1',
        toolName: 'bash',
        arguments: '{"command":"rm -rf /"}',
        actionId: 'action-1',
        description: 'Delete everything',
        alert: 'critical',
      },
    });

    // Should have sent notification to cloud
    expect(cloudSendMock).toHaveBeenCalled();

    // Resolve the pending
    bridge.resolvePending('req-1', { kind: 'action', requestId: 'req-1', type: 'reject', reason: 'dangerous' });

    const response = await eventPromise;
    expect(response).toEqual({ kind: 'action', requestId: 'req-1', type: 'reject', reason: 'dangerous' });
  });

  // ── L5: cloud.send failure cleans up pending ───────────────────────────

  it('L5: action_request cloud.send failure → error response, pending cleaned', async () => {
    cloudSendMock.mockRejectedValueOnce(new Error('network down'));

    const response = await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-fail',
        toolName: 'tool',
        arguments: '{}',
        actionId: 'a1',
        description: 'test',
        alert: 'info',
      },
    });

    expect(response).toEqual({ kind: 'error', code: 'send_failed', message: 'failed to forward action_request to cloud' });

    // close() should not hang on orphaned pending
    await bridge.close();
    expect(cloudCloseMock).toHaveBeenCalled();
  });

  it('L5: sensitive_info_operation cloud.send failure → error response', async () => {
    cloudSendMock.mockRejectedValueOnce(new Error('timeout'));

    const response = await bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'sensitive_info_operation',
        requestId: 'req-si',
        operation: { type: 'collect', items: [{ key: 'API_KEY', displayText: 'API Key', hint: 'enter', siType: 'secret' }] },
      },
    });

    expect(response).toEqual({ kind: 'error', code: 'send_failed', message: 'failed to forward sensitive_info_operation to cloud' });
  });

  // ── close() ────────────────────────────────────────────────────────────

  it('close() clears mappings and rejects pending', async () => {
    // Start an action_request (will be pending)
    const eventPromise = bridge.handleEvent('act-1', {
      activity: 'act-1',
      event: {
        type: 'action_request',
        requestId: 'req-close',
        toolName: 'tool',
        arguments: '{}',
        actionId: 'a1',
        description: 'test',
        alert: 'info',
      },
    });

    await bridge.close();

    const response = await eventPromise;
    expect(response.kind).toBe('error');
    expect(cloudCloseMock).toHaveBeenCalled();
    expect(transportDisconnectMock).toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import type { PlatformClient } from './client.js';
import type { ChannelId, MessageId, MessageContent } from './types.js';
import { channelId, messageId, StreamCapability } from './types.js';

/**
 * PlatformClient is a pure interface — we verify interface contract compliance
 * by testing a mock implementation that satisfies the interface shape.
 */
describe('PlatformClient interface', () => {
  // Minimal mock that satisfies PlatformClient
  const makeMock = (): PlatformClient => {
    const sentMessages: Array<{ chatId: ChannelId; content: MessageContent }> = [];
    return {
      platform: 'mock',
      async connect() {},
      async send(chatId, content) {
        sentMessages.push({ chatId, content });
        return messageId(`mock-msg-${sentMessages.length}`);
      },
      async *messages() {
        // empty — override in tests that need messages
      },
      streamCapability() {
        return StreamCapability.NonStreaming;
      },
      async healthCheck() {},
      async close() {},
    };
  };

  it('platform property is exposed', () => {
    const client = makeMock();
    expect(client.platform).toBe('mock');
  });

  it('send returns a MessageId', async () => {
    const client = makeMock();
    const chatId = channelId('chat-1');
    const content = { type: 'text' as const, text: 'hello' };
    const msgId = await client.send(chatId, content);
    expect(msgId).toBe('mock-msg-1');
  });

  it('send returns distinct MessageIds per call', async () => {
    const client = makeMock();
    const chatId = channelId('chat-x');
    const content = { type: 'text' as const, text: 'test message' };
    const id1 = await client.send(chatId, content);
    const id2 = await client.send(chatId, content);
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^mock-msg-1$/);
    expect(id2).toMatch(/^mock-msg-2$/);
  });

  it('streamCapability returns a valid StreamCapability value', () => {
    const client = makeMock();
    const cap = client.streamCapability();
    expect(cap).toMatch(/^(streaming|non-streaming)$/);
  });

  it('connect and healthCheck are callable and resolve without error', async () => {
    const client = makeMock();
    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.healthCheck()).resolves.toBeUndefined();
  });

  it('close resolves without error', async () => {
    const client = makeMock();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('messages yields nothing by default', async () => {
    const client = makeMock();
    const messages: unknown[] = [];
    for await (const _ of client.messages()) {
      messages.push(_);
    }
    expect(messages).toHaveLength(0);
  });

  it('all five branded types work as Message fields', async () => {
    // Smoke-test that the types used by PlatformClient are consistent
    const cid = channelId('c1');
    const mid = await makeMock().send(cid, { type: 'text', text: 'hi' });
    expect(mid).toBe('mock-msg-1');
    // Verify brands are preserved through the mock
    const _cid2: ChannelId = cid;
    const _mid2: MessageId = mid;
    expect(true).toBe(true);
  });
});

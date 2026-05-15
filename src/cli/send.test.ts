import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
import type { MessageId, StreamCapability } from '../core/types.js';
import { channelId, messageId, userId, StreamCapability as SC } from '../core/types.js';
import { send } from './send.js';

function mockClient(): PlatformClient & { sent: Array<{ chatId: string; text: string }>; lastMsgId: MessageId } {
  return {
    platform: 'mock',
    sent: [],
    lastMsgId: messageId('mock-id'),
    async connect() {},
    async send(chatId, content) {
      this.sent.push({ chatId: chatId as string, text: (content as { text: string }).text });
      return this.lastMsgId;
    },
    async *messages() {},
    streamCapability() {
      return SC.NonStreaming;
    },
    async healthCheck() {},
    async close() {},
  };
}

describe('send', () => {
  it('sends the given text to the specified chatId', async () => {
    const client = mockClient();
    const chatId = channelId('och_123');

    await send(client, 'hello world', { chatId });

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.chatId).toBe('och_123');
    expect(client.sent[0]!.text).toBe('hello world');
  });

  it('writes a confirmation to the writer', async () => {
    const client = mockClient();
    const output: string[] = [];

    await send(client, 'test', { chatId: channelId('och_abc'), writer: (chunk) => output.push(chunk) });

    expect(output[0]).toMatch(/Message sent/);
    expect(output[0]).toMatch(/och_abc/);
    expect(output[0]).toMatch(/mock-id/);
  });

  it('returns the message id from client.send', async () => {
    const client = mockClient();
    client.lastMsgId = messageId('custom-msg-id');

    const msgId = await send(client, 'hello', { chatId: channelId('och_1') });

    expect(msgId).toBe('custom-msg-id');
  });

  it('handles multi-word messages', async () => {
    const client = mockClient();

    await send(client, 'Hello World 123', { chatId: channelId('och_multi') });

    expect(client.sent[0]!.text).toBe('Hello World 123');
  });
});

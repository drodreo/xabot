import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
import type { Message, StreamCapability } from '../core/types.js';
import { channelId, userId, messageId, StreamCapability as SC } from '../core/types.js';
import { listen } from './listen.js';

const FAST_TIMEOUT = 50; // ms

function mockClient(messages: Message[]): PlatformClient {
  let closed = false;
  return {
    platform: 'mock',
    async connect() {},
    async send() {
      return messageId('mock-id');
    },
    async *messages() {
      for (const msg of messages) {
        if (closed) break;
        yield msg;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    streamCapability() {
      return SC.NonStreaming;
    },
    async healthCheck() {},
    async close() {
      closed = true;
    },
  };
}

function textMsg(chatId: string, senderId: string, text: string): Message {
  return {
    id: messageId('m1'),
    chatId: channelId(chatId),
    senderId: userId(senderId),
    content: { type: 'text', text },
    direction: 'incoming',
  };
}

function imageMsg(chatId: string, senderId: string, url: string): Message {
  return {
    id: messageId('m2'),
    chatId: channelId(chatId),
    senderId: userId(senderId),
    content: { type: 'image', url },
    direction: 'incoming',
  };
}

describe('listen', () => {
  it('writes each incoming message to the writer', async () => {
    const output: string[] = [];
    const writer = (chunk: string) => output.push(chunk);

    const messages = [
      textMsg('c1', 'u1', 'hello'),
      textMsg('c2', 'u2', 'world'),
    ];

    await listen(mockClient(messages), { writer });
    expect(output).toHaveLength(2);
    expect(output[0]).toMatch(/hello/);
    expect(output[1]).toMatch(/world/);
  });

  it('uses custom formatter when provided', async () => {
    const output: string[] = [];
    const writer = (chunk: string) => output.push(chunk);
    const formatter = (msg: Message) => `CUSTOM:${msg.content.type}:${(msg.content as { text: string }).text}`;

    await listen(mockClient([textMsg('c1', 'u1', 'test')]), { writer, formatter });
    expect(output[0]).toBe('CUSTOM:text:test\n');
  });

  it('shows incoming direction arrow for incoming messages', async () => {
    const output: string[] = [];
    await listen(mockClient([textMsg('c1', 'u1', 'hi')]), {
      writer: (chunk) => output.push(chunk),
    });
    expect(output[0]).toContain('⬇');
  });

  it('shows image message type', async () => {
    const output: string[] = [];
    await listen(mockClient([imageMsg('c1', 'u1', 'http://example.com/pic.png')]), {
      writer: (chunk) => output.push(chunk),
    });
    expect(output[0]).toMatch(/\[image\]/);
  });

  it('stops when message stream ends', async () => {
    const output: string[] = [];
    await listen(mockClient([]), { writer: (chunk) => output.push(chunk) });
    expect(output).toHaveLength(0);
  });
});

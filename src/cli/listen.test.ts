import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
import type { Message, StreamCapability, ChannelId, MessageId } from '../core/types.js';
import { channelId, userId, messageId, StreamCapability as SC } from '../core/types.js';
import { listen } from './listen.js';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(messages: Message[], sent?: { texts: string[] }, noDelay = false): PlatformClient {
  let closed = false;
  return {
    platform: 'mock',
    async connect() {},
    async send(chatId: ChannelId, content: { type: string; text: string }): Promise<MessageId> {
      sent?.texts.push(content.text);
      return messageId('mock-id');
    },
    async *messages() {
      for (const msg of messages) {
        if (closed) break;
        yield msg;
        if (!noDelay) {
          await new Promise((r) => setTimeout(r, 5));
        }
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

/** Create a readable stream that yields lines then closes. */
function linesToStdin(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n'));
}

/** An empty stdin that closes immediately. */
function emptyStdin(): Readable {
  return Readable.from([]);
}

/** Create a client whose messages() blocks until resolve is called. */
function blockingClient(sent?: { texts: string[] }): { client: PlatformClient; resolve: () => void } {
  let resolve!: () => void;
  const blocked = new Promise<void>((r) => { resolve = r; });

  const client: PlatformClient = {
    platform: 'mock',
    async connect() {},
    async send(chatId: ChannelId, content: { type: string; text: string }) {
      sent?.texts.push(content.text);
      return messageId('mock-id');
    },
    async *messages() {
      await blocked;
    },
    streamCapability() { return SC.NonStreaming; },
    async healthCheck() {},
    async close() {},
  };

  return { client, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listen', () => {
  it('writes each incoming message to stderr', async () => {
    const output: string[] = [];
    const stderr = (chunk: string) => output.push(chunk);

    const messages = [
      textMsg('c1', 'u1', 'hello'),
      textMsg('c2', 'u2', 'world'),
    ];

    await listen(mockClient(messages, undefined, true), {
      chatId: channelId('chat-x'),
      stderr,
      stdin: emptyStdin(),
    });

    const combined = output.join('');
    expect(combined).toContain('hello');
    expect(combined).toContain('world');
  });

  it('uses custom formatter when provided', async () => {
    const output: string[] = [];
    const stderr = (chunk: string) => output.push(chunk);
    const formatter = (msg: Message) => `CUSTOM:${msg.content.type}:${(msg.content as { text: string }).text}`;

    await listen(mockClient([textMsg('c1', 'u1', 'test')]), {
      chatId: channelId('chat-x'),
      stderr,
      formatter,
      stdin: emptyStdin(),
    });

    expect(output.some((o) => o === 'CUSTOM:text:test\n')).toBe(true);
  });

  it('shows incoming direction arrow for incoming messages', async () => {
    const output: string[] = [];
    await listen(mockClient([textMsg('c1', 'u1', 'hi')]), {
      chatId: channelId('chat-x'),
      stderr: (chunk) => output.push(chunk),
      stdin: emptyStdin(),
    });
    expect(output.some((o) => o.includes('⬇'))).toBe(true);
  });

  it('shows image message type', async () => {
    const output: string[] = [];
    await listen(mockClient([imageMsg('c1', 'u1', 'http://example.com/pic.png')]), {
      chatId: channelId('chat-x'),
      stderr: (chunk) => output.push(chunk),
      stdin: emptyStdin(),
    });
    expect(output.some((o) => /\[image\]/.test(o))).toBe(true);
  });

  it('stops when message stream ends', async () => {
    const output: string[] = [];
    await listen(mockClient([]), {
      chatId: channelId('chat-x'),
      stderr: (chunk) => output.push(chunk),
      stdin: emptyStdin(),
    });
    // Only the prompt line, no messages
    const combined = output.join('');
    expect(combined).toContain('Type a message and press Enter');
    expect(combined).not.toContain('⬇');
  });

  it('sends stdin lines to the configured chatId', async () => {
    const sent: { texts: string[] } = { texts: [] };
    const { client, resolve } = blockingClient(sent);

    const listenPromise = listen(client, {
      chatId: channelId('chat-x'),
      stdin: linesToStdin(['hello', 'world']),
    });

    await listenPromise;
    resolve();

    expect(sent.texts).toEqual(['hello', 'world']);
  });

  it('does not send empty or whitespace-only lines', async () => {
    const sent: { texts: string[] } = { texts: [] };
    const { client, resolve } = blockingClient(sent);

    const listenPromise = listen(client, {
      chatId: channelId('chat-x'),
      stdin: linesToStdin(['hello', '', '   ', 'world']),
    });

    await listenPromise;
    resolve();

    expect(sent.texts).toEqual(['hello', 'world']);
  });

  it('reports send errors to stderr without crashing', async () => {
    const output: string[] = [];
    const { client, resolve } = blockingClient();

    const failingClient: PlatformClient = {
      ...client,
      async send() {
        throw new Error('network down');
      },
    };

    const listenPromise = listen(failingClient, {
      chatId: channelId('chat-x'),
      stderr: (chunk) => output.push(chunk),
      stdin: linesToStdin(['oops']),
    });

    await listenPromise;
    resolve();

    const combined = output.join('');
    expect(combined).toContain('Send failed');
    expect(combined).toContain('network down');
  });
});

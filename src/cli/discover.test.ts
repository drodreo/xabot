import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
import type { ChannelId, Message, MessageContent, MessageId, StreamCapability } from '../core/types.js';
import { channelId, userId, messageId, StreamCapability as SC } from '../core/types.js';
import { discover, DiscoverTimeoutError } from './discover.js';

const FAST_TIMEOUT = 100; // ms — short enough to make timeout tests fast

/** Build a mock PlatformClient whose messages() yields the given sequence. */
function mockClient(messages: Message[]): PlatformClient {
  let closed = false;
  return {
    platform: 'mock',
    async connect() {},
    async send() {
      return messageId('mock-msg-id');
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

function textMsg(chatId: ChannelId, senderId: string, text: string): Message {
  return {
    id: messageId(`msg-${Math.random().toString(36).slice(2)}`),
    chatId,
    senderId: userId(senderId),
    content: { type: 'text', text } as MessageContent,
    direction: 'incoming',
  };
}

function imageMsg(chatId: ChannelId, senderId: string, url: string): Message {
  return {
    id: messageId(`msg-${Math.random().toString(36).slice(2)}`),
    chatId,
    senderId: userId(senderId),
    content: { type: 'image', url } as MessageContent,
    direction: 'incoming',
  };
}

describe('discover', () => {
  it('returns chatId when a message with the correct pairing code is received', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writer = (chunk: string) => stdout.push(chunk);
    const errWriter = (chunk: string) => stderr.push(chunk);

    const chat = channelId('chat-alpha');
    const CODE = 'TESTAB';

    const result = await discover(mockClient([textMsg(chat, 'user1', CODE)]), {
      timeoutMs: FAST_TIMEOUT,
      writer,
      stderr: errWriter,
      pairingCode: CODE,
    });

    expect(result).toBe(chat);
    expect(stderr.join('')).toMatch(/配对码：TESTAB/);
    const json = JSON.parse(stdout.join('').trim());
    expect(json).toEqual({ ok: true, chatId: 'chat-alpha' });
  });

  it('throws DiscoverTimeoutError when no matching message arrives before timeout', async () => {
    const output: string[] = [];
    const writer = (chunk: string) => output.push(chunk);

    const client = mockClient([
      textMsg(channelId('chat-x'), 'user1', 'WRONG1'),
      textMsg(channelId('chat-x'), 'user1', 'WRONG2'),
    ]);

    await expect(
      discover(client, { timeoutMs: FAST_TIMEOUT, writer, pairingCode: 'CORRECT' }),
    ).rejects.toThrow(DiscoverTimeoutError);
  });

  it('ignores wrong pairing codes and succeeds when a later message matches', async () => {
    const stdout: string[] = [];
    const writer = (chunk: string) => stdout.push(chunk);

    const chat = channelId('chat-beta');
    const CODE = 'PAIRCD';

    const client = mockClient([
      textMsg(channelId('chat-x'), 'u1', 'NOTCODE1'),
      textMsg(channelId('chat-x'), 'u2', 'NOTCODE2'),
      textMsg(chat, 'user1', CODE),
      textMsg(channelId('chat-y'), 'u3', 'AFTER'),
    ]);

    const result = await discover(client, { timeoutMs: FAST_TIMEOUT, writer, pairingCode: CODE });
    expect(result).toBe(chat);
    const json = JSON.parse(stdout.join('').trim());
    expect(json).toEqual({ ok: true, chatId: 'chat-beta' });
  });

  it('ignores non-text messages and succeeds when a text message with the correct code arrives', async () => {
    const stdout: string[] = [];
    const writer = (chunk: string) => stdout.push(chunk);

    const chat = channelId('chat-gamma');
    const CODE = 'IMGCODE';

    const client = mockClient([
      imageMsg(chat, 'u1', 'http://example.com/pic.png'),
      textMsg(channelId('chat-x'), 'u1', 'STILLWRONG'),
      textMsg(chat, 'u2', CODE),
    ]);

    const result = await discover(client, { timeoutMs: FAST_TIMEOUT, writer, pairingCode: CODE });
    expect(result).toBe(chat);
    const json = JSON.parse(stdout.join('').trim());
    expect(json).toEqual({ ok: true, chatId: 'chat-gamma' });
  });

  it('outputs pairing code instruction to stderr', async () => {
    const stderr: string[] = [];
    const errWriter = (chunk: string) => stderr.push(chunk);

    const client = mockClient([textMsg(channelId('chat-x'), 'u1', 'NOMATCH')]);

    await expect(
      discover(client, { timeoutMs: 60_000, stderr: errWriter, pairingCode: 'OUTCODE' }),
    ).rejects.toThrow(DiscoverTimeoutError);

    const combined = stderr.join('');
    expect(combined).toMatch(/配对码：OUTCODE/);
    expect(combined).toMatch(/60 秒内/);
  });

  it('throws DiscoverTimeoutError when stream ends without any matching message', async () => {
    const output: string[] = [];
    const writer = (chunk: string) => output.push(chunk);

    // Empty array — messages() yields nothing and stream ends immediately
    const client = mockClient([]);

    await expect(
      discover(client, { timeoutMs: FAST_TIMEOUT, writer, pairingCode: 'NEVER' }),
    ).rejects.toThrow(DiscoverTimeoutError);
  });
});

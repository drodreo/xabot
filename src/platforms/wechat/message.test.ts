import { describe, it, expect } from 'vitest';
import { toStandardMessage, fromMessageContent } from './message.js';
import { channelId } from '../../core/types.js';

describe('toStandardMessage', () => {
  it('converts a text message event', () => {
    const event = {
      msgId: 'msg_123',
      fromUserName: 'user_alice',
      toUserName: 'bot_channel',
      msgType: 'text',
      content: 'hello there',
      createTime: 1700000000,
    };

    const msg = toStandardMessage(event);

    expect(msg.id).toBe('msg_123');
    expect(msg.chatId).toBe('bot_channel');
    expect(msg.senderId).toBe('user_alice');
    expect(msg.content).toEqual({ type: 'text', text: 'hello there' });
    expect(msg.direction).toBe('incoming');
  });

  it('converts an image message event', () => {
    const event = {
      msgId: 'msg_456',
      fromUserName: 'user_bob',
      toUserName: 'bot_channel',
      msgType: 'image',
      content: '',
      mediaUrl: 'https://cdn.example.com/img.jpg',
      createTime: 1700000001,
    };

    const msg = toStandardMessage(event);

    expect(msg.id).toBe('msg_456');
    expect(msg.content).toEqual({
      type: 'image',
      url: 'https://cdn.example.com/img.jpg',
    });
  });

  it('converts a file message event', () => {
    const event = {
      msgId: 'msg_789',
      fromUserName: 'user_carol',
      toUserName: 'bot_channel',
      msgType: 'file',
      content: 'report.pdf',
      mediaUrl: 'https://cdn.example.com/report.pdf',
      createTime: 1700000002,
    };

    const msg = toStandardMessage(event);

    expect(msg.content).toEqual({
      type: 'file',
      url: 'https://cdn.example.com/report.pdf',
      name: 'report.pdf',
    });
  });

  it('handles missing msgId by generating a fallback id', () => {
    const event = {
      fromUserName: 'user_dave',
      toUserName: 'bot_channel',
      msgType: 'text',
      content: 'no id here',
    };

    const msg = toStandardMessage(event);

    expect(msg.id).toMatch(/\d+/);
    expect(msg.content).toEqual({ type: 'text', text: 'no id here' });
  });

  it('handles unknown msgType as text fallback', () => {
    const event = {
      msgId: 'msg_unknown',
      fromUserName: 'user_eve',
      toUserName: 'bot_channel',
      msgType: 'unknown_type',
      content: 'raw event data',
    };

    const msg = toStandardMessage(event);

    expect(msg.content).toEqual({ type: 'text', text: 'raw event data' });
  });
});

describe('fromMessageContent', () => {
  it('converts a text content to wechat body', () => {
    const body = fromMessageContent('user_alice', { type: 'text', text: 'hello world' });

    expect(body).toEqual({
      toUser: 'user_alice',
      msgType: 'text',
      content: 'hello world',
      mediaUrl: undefined,
    });
  });

  it('converts an image content to wechat body', () => {
    const body = fromMessageContent('user_bob', {
      type: 'image',
      url: 'https://cdn.example.com/photo.png',
    });

    expect(body).toEqual({
      toUser: 'user_bob',
      msgType: 'image',
      content: 'https://cdn.example.com/photo.png',
      mediaUrl: 'https://cdn.example.com/photo.png',
    });
  });

  it('converts a file content to wechat body', () => {
    const body = fromMessageContent('user_carol', {
      type: 'file',
      url: 'https://cdn.example.com/doc.pdf',
      name: 'doc.pdf',
    });

    expect(body).toEqual({
      toUser: 'user_carol',
      msgType: 'file',
      content: 'doc.pdf',
      mediaUrl: 'https://cdn.example.com/doc.pdf',
    });
  });

  it('uses chatId as toUser', () => {
    const body = fromMessageContent(channelId('oc_chat1'), { type: 'text', text: 'ping' });

    expect(body.toUser).toBe('oc_chat1');
  });
});

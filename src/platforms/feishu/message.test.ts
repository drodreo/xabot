import { describe, it, expect } from 'vitest';
import {
  toStandardMessage,
  fromMessageContent,
  type FeishuMessageEvent,
} from './message.js';
import { channelId, messageId, userId } from '../../core/types.js';

describe('toStandardMessage', () => {
  it('converts a text message event', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: 'ou_abc123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_xxx',
        chat_id: 'oc_yyy',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello world' }),
      },
    };

    const msg = toStandardMessage(event);

    expect(msg.id).toBe('om_xxx');
    expect(msg.chatId).toBe('oc_yyy');
    expect(msg.senderId).toBe('ou_abc123');
    expect(msg.direction).toBe('incoming');
    expect(msg.content).toEqual({ type: 'text', text: 'hello world' });
  });

  it('prefers open_id over user_id and union_id', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: 'ou_preferred', user_id: 'ui_backup', union_id: 'un_fallback' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      },
    };

    expect(toStandardMessage(event).senderId).toBe('ou_preferred');
  });

  it('falls back to user_id when open_id is missing', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { user_id: 'ui_fallback', union_id: 'un_fallback' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      },
    };

    expect(toStandardMessage(event).senderId).toBe('ui_fallback');
  });

  it('converts an image message event', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: 'ou_img' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_img',
        chat_id: 'oc_img',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v2_abc123' }),
      },
    };

    const msg = toStandardMessage(event);

    expect(msg.content).toEqual({ type: 'image', source: { localUri: '', remoteUrl: 'img_v2_abc123', mimeType: '', sizeBytes: 0 } });
  });

  it('converts a file message event', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: 'ou_file' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_file',
        chat_id: 'oc_file',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'group',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v2_xyz', file_name: 'report.pdf' }),
      },
    };

    const msg = toStandardMessage(event);

    expect(msg.content).toEqual({
      type: 'file',
      source: { localUri: '', remoteUrl: 'file_v2_xyz', mimeType: '', sizeBytes: 0 },
      name: 'report.pdf',
    });
  });

  it('treats unknown message types as text fallback', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: 'ou_unknown' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_unknown',
        chat_id: 'oc_unknown',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'group',
        message_type: 'unsupported_type',
        content: 'raw content here',
      },
    };

    const msg = toStandardMessage(event);

    expect(msg.content).toEqual({ type: 'text', text: 'raw content here' });
  });

  it('handles empty open_id gracefully', () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {},
        sender_type: 'user',
      },
      message: {
        message_id: 'om_empty',
        chat_id: 'oc_empty',
        create_time: '2025-01-01T00:00:00Z',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'no sender id' }),
      },
    };

    const msg = toStandardMessage(event);

    expect(msg.senderId).toBe('');
  });
});

describe('fromMessageContent', () => {
  it('builds a text message body', () => {
    const body = fromMessageContent('oc_chat1', { type: 'text', text: 'hello' });

    expect(body.receive_id).toBe('oc_chat1');
    expect(body.msg_type).toBe('text');
    expect(body.content).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('builds an image message body', () => {
    const body = fromMessageContent('oc_chat1', {
      type: 'image',
      source: { localUri: '', remoteUrl: 'img_v2_abc', mimeType: '', sizeBytes: 0 },
    });

    expect(body.receive_id).toBe('oc_chat1');
    expect(body.msg_type).toBe('image');
    expect(body.content).toBe(JSON.stringify({ image_key: 'img_v2_abc' }));
  });

  it('builds a file message body', () => {
    const body = fromMessageContent('oc_chat1', {
      type: 'file',
      source: { localUri: '', remoteUrl: 'file_v2_xyz', mimeType: '', sizeBytes: 0 },
    });

    expect(body.receive_id).toBe('oc_chat1');
    expect(body.msg_type).toBe('file');
    expect(body.content).toBe(JSON.stringify({ file_key: 'file_v2_xyz', file_name: 'file_v2_xyz' }));
  });
});

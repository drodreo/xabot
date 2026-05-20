import { describe, it, expect } from 'vitest';
import { toStandardMessage, fromMessageContent, extractContextToken, extractText } from './message.js';

describe('toStandardMessage', () => {
  it('converts a text message', () => {
    const msg = {
      from_user_id: 'user_alice',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
      msg_id: 'msg_123',
    };

    const result = toStandardMessage(msg);
    expect(result.id).toBe('msg_123');
    expect(result.chatId).toBe('user_alice');
    expect(result.senderId).toBe('user_alice');
    expect(result.content).toEqual({ type: 'text', text: 'hello' });
    expect(result.direction).toBe('incoming');
  });

  it('converts an image message', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_2',
      item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn.example.com/img.jpg' } } }],
      msg_id: 'msg_456',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'image', source: { localUri: '', remoteUrl: 'https://cdn.example.com/img.jpg', mimeType: '', sizeBytes: 0 } });
  });

  it('converts a file message', () => {
    const msg = {
      from_user_id: 'user_carol',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_3',
      item_list: [{ type: 4, file_item: { file_name: 'report.pdf', media: { full_url: 'https://cdn.example.com/report.pdf' } } }],
      msg_id: 'msg_789',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'file', name: 'report.pdf', source: { localUri: '', remoteUrl: 'https://cdn.example.com/report.pdf', mimeType: '', sizeBytes: 0 } });
  });

  it('handles unknown item type as fallback', () => {
    const msg = {
      from_user_id: 'user_dave',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_4',
      item_list: [{ type: 99, unknown: {} } as any],
      msg_id: 'msg_unknown',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[unsupported]' });
  });

  it('handles missing image_item as text fallback', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_img',
      item_list: [{ type: 2 } as any],
      msg_id: 'msg_img_missing',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[image]' });
  });

  it('handles missing image_item.media as text fallback', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_img',
      item_list: [{ type: 2, image_item: {} } as any],
      msg_id: 'msg_img_media_missing',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[image]' });
  });

  it('handles empty image full_url as text fallback', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_img',
      item_list: [{ type: 2, image_item: { media: { full_url: '' } } } as any],
      msg_id: 'msg_img_empty',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[image]' });
  });

  it('handles missing file_item as text fallback', () => {
    const msg = {
      from_user_id: 'user_carol',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_file',
      item_list: [{ type: 4 } as any],
      msg_id: 'msg_file_missing',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[file]' });
  });

  it('handles missing voice_item.media as text fallback', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_audio',
      item_list: [{ type: 3, voice_item: {} } as any],
      msg_id: 'msg_voice_cdn_missing',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[audio]' });
  });

  it('handles missing video_item.media as text fallback', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_video',
      item_list: [{ type: 5, video_item: {} } as any],
      msg_id: 'msg_video_cdn_missing',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '[video]' });
  });

  it('handles missing msg_id with timestamp fallback', () => {
    const msg = {
      from_user_id: 'user_eve',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_5',
      item_list: [{ type: 1, text_item: { text: 'no id' } }],
    };

    const result = toStandardMessage(msg);
    expect(result.id).toMatch(/\d+/);
    expect(result.content).toEqual({ type: 'text', text: 'no id' });
  });
});

describe('fromMessageContent', () => {
  it('converts text to send request', () => {
    const req = fromMessageContent('user_alice', { type: 'text', text: 'hello' }, 'ctx_send');
    expect(req.msg.to_user_id).toBe('user_alice');
    expect(req.msg.message_type).toBe(2);
    expect(req.msg.message_state).toBe(2);
    expect(req.msg.context_token).toBe('ctx_send');
    expect(req.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }]);
    expect(req.base_info).toEqual({ channel_version: '1' });
    expect(req.msg.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('converts image to text fallback', () => {
    const req = fromMessageContent('user_bob', { type: 'image', source: { localUri: '', remoteUrl: 'https://cdn.example.com/photo.png', mimeType: '', sizeBytes: 0 } }, 'ctx_img');
    expect(req.msg.item_list).toEqual([{ type: 1, text_item: { text: '[image]' } }]);
  });

  it('converts file to text fallback', () => {
    const req = fromMessageContent('user_carol', { type: 'file', source: { localUri: '', remoteUrl: 'https://cdn.example.com/doc.pdf', mimeType: '', sizeBytes: 0 } }, 'ctx_file');
    expect(req.msg.item_list).toEqual([{ type: 1, text_item: { text: '[file: doc.pdf]' } }]);
  });
});

describe('extractContextToken', () => {
  it('returns context_token', () => {
    const msg = { context_token: 'ctx_abc' } as any;
    expect(extractContextToken(msg)).toBe('ctx_abc');
  });
});

describe('extractText', () => {
  it('returns first text item text', () => {
    const msg = { item_list: [{ type: 1, text_item: { text: 'hello' } }] } as any;
    expect(extractText(msg)).toBe('hello');
  });

  it('returns empty string when no text item', () => {
    const msg = { item_list: [{ type: 2, image_item: { media: { full_url: '' } } }] } as any;
    expect(extractText(msg)).toBe('');
  });
});

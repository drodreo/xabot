import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toStandardMessage, fromMessageContent, extractContextToken, extractText, processInboundMedia } from './message.js';
import { downloadToBuffer, saveTemp } from '../../core/fs-utils.js';
import { decryptBuffer } from './crypto.js';

vi.mock('../../core/fs-utils.js', () => ({
  downloadToBuffer: vi.fn(),
  saveTemp: vi.fn(),
}));

vi.mock('./crypto.js', () => ({
  decryptBuffer: vi.fn(),
}));

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

  it('non-text items return empty text (media handled by processInboundMedia)', () => {
    const msg = {
      from_user_id: 'user_bob',
      to_user_id: 'bot_123',
      message_type: 1,
      context_token: 'ctx_2',
      item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn.example.com/img.jpg' } } }],
      msg_id: 'msg_456',
    };

    const result = toStandardMessage(msg);
    expect(result.content).toEqual({ type: 'text', text: '' });
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

// --------------------------------------------------------------------------
// processInboundMedia
// --------------------------------------------------------------------------

describe('processInboundMedia', () => {
  beforeEach(() => {
    vi.mocked(downloadToBuffer).mockReset();
    vi.mocked(decryptBuffer).mockReset();
    vi.mocked(saveTemp).mockReset();
  });

  it('image: downloads, decrypts with aesKey, saves, returns content', async () => {
    vi.mocked(downloadToBuffer).mockResolvedValue(Buffer.from('encrypted'));
    vi.mocked(decryptBuffer).mockReturnValue(Buffer.from('decrypted'));
    vi.mocked(saveTemp).mockResolvedValue({ localUri: '/tmp/img.png', sha256: 'abc', sizeBytes: 10, mimeType: 'image/png' });

    const item = { type: 2, image_item: { media: { full_url: 'https://cdn.com/img.png', aes_key: 'key123' } } } as any;
    const result = await processInboundMedia(item);

    expect(downloadToBuffer).toHaveBeenCalledWith('https://cdn.com/img.png');
    expect(decryptBuffer).toHaveBeenCalledWith(Buffer.from('encrypted'), 'key123');
    expect(saveTemp).toHaveBeenCalledWith(Buffer.from('decrypted'), 'https://cdn.com/img.png', undefined);
    expect(result).toEqual({
      type: 'image',
      source: { localUri: '/tmp/img.png', sha256: 'abc', sizeBytes: 10, mimeType: 'image/png', requireOrganized: true, remoteUrl: 'https://cdn.com/img.png' },
    });
  });

  it('skips decrypt when no aesKey', async () => {
    vi.mocked(downloadToBuffer).mockResolvedValue(Buffer.from('plaintext'));
    vi.mocked(saveTemp).mockResolvedValue({ localUri: '/tmp/img.png', sha256: 'def', sizeBytes: 10, mimeType: 'image/png' });

    const item = { type: 2, image_item: { media: { full_url: 'https://cdn.com/img.png' } } } as any;
    const result = await processInboundMedia(item);

    expect(decryptBuffer).not.toHaveBeenCalled();
    expect(saveTemp).toHaveBeenCalledWith(Buffer.from('plaintext'), 'https://cdn.com/img.png', undefined);
  });

  it('file: passes file_name as hint', async () => {
    vi.mocked(downloadToBuffer).mockResolvedValue(Buffer.from('encrypted'));
    vi.mocked(decryptBuffer).mockReturnValue(Buffer.from('decrypted'));
    vi.mocked(saveTemp).mockResolvedValue({ localUri: '/tmp/doc.pdf', sha256: 'xyz', sizeBytes: 20, mimeType: 'application/pdf' });

    const item = { type: 4, file_item: { file_name: 'report.pdf', media: { full_url: 'https://cdn.com/doc.pdf', aes_key: 'key456' } } } as any;
    const result = await processInboundMedia(item);

    expect(decryptBuffer).toHaveBeenCalledWith(Buffer.from('encrypted'), 'key456');
    expect(saveTemp).toHaveBeenCalledWith(Buffer.from('decrypted'), 'https://cdn.com/doc.pdf', 'report.pdf');
    expect(result).toEqual({
      type: 'file',
      name: 'report.pdf',
      source: { localUri: '/tmp/doc.pdf', sha256: 'xyz', sizeBytes: 20, mimeType: 'application/pdf', requireOrganized: true, remoteUrl: 'https://cdn.com/doc.pdf' },
    });
  });

  it('voice maps to audio type', async () => {
    vi.mocked(downloadToBuffer).mockResolvedValue(Buffer.from('voice'));
    vi.mocked(saveTemp).mockResolvedValue({ localUri: '/tmp/voice.opus', sha256: 'v1', sizeBytes: 5, mimeType: 'audio/opus' });

    const item = { type: 3, voice_item: { media: { full_url: 'https://cdn.com/voice.opus' } } } as any;
    const result = await processInboundMedia(item);

    expect(result).toEqual({
      type: 'audio',
      source: { localUri: '/tmp/voice.opus', sha256: 'v1', sizeBytes: 5, mimeType: 'audio/opus', requireOrganized: true, remoteUrl: 'https://cdn.com/voice.opus' },
    });
  });

  it('throws on download failure', async () => {
    vi.mocked(downloadToBuffer).mockRejectedValue(new Error('network down'));

    const item = { type: 2, image_item: { media: { full_url: 'https://cdn.com/img.png' } } } as any;
    await expect(processInboundMedia(item)).rejects.toThrow('图片接收失败：network down');
  });

  it('throws on decrypt failure', async () => {
    vi.mocked(downloadToBuffer).mockResolvedValue(Buffer.from('encrypted'));
    vi.mocked(decryptBuffer).mockImplementation(() => { throw new Error('bad key'); });

    const item = { type: 2, image_item: { media: { full_url: 'https://cdn.com/img.png', aes_key: 'bad' } } } as any;
    await expect(processInboundMedia(item)).rejects.toThrow('图片接收失败：bad key');
  });

  it('throws when missing url', async () => {
    const item = { type: 2, image_item: { media: {} } } as any;
    await expect(processInboundMedia(item)).rejects.toThrow('图片接收失败：缺少下载地址');
    expect(downloadToBuffer).not.toHaveBeenCalled();
  });

  it('throws on unknown media type', async () => {
    const item = { type: 99 } as any;
    await expect(processInboundMedia(item)).rejects.toThrow('未知媒体类型: 99');
  });

  it('returns empty text for text item', async () => {
    const item = { type: 1, text_item: { text: 'hello' } } as any;
    const result = await processInboundMedia(item);

    expect(result).toEqual({ type: 'text', text: '' });
  });
});

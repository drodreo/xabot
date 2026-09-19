import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bridge } from './index.js';
import { channelId, userId, messageId, type ChannelId, type Message, type MessageContent } from '../core/types.js';
import { genericCommand, genericResponse } from 'xacpp';
import type { XacppTransport, XacppSession, XacppResponse, ContentPart } from 'xacpp';
import { fromMessagePartsAggregated } from '../platforms/wechat/message.js';
import type { WechatUploadResult } from '../platforms/wechat/upload.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    return { [Symbol.asyncIterator]: function (): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (self.queue.length > 0) {
            return { value: self.queue.shift()!, done: false };
          }
          if (self.stopped) {
            return { value: undefined as never, done: true };
          }
          return new Promise<IteratorResult<T>>((r) => { self.waiting = r; });
        },
      };
    } };
  }
}

function mockSession(credentials: string = 'chat-a'): XacppSession {
  return {
    sessionId: 'sess-1',
    credentials,
    requestCommand: vi.fn(),
  } as unknown as XacppSession;
}

function fileRef(name: string) {
  return {
    remoteUrl: `https://cdn.example.com/${name}`,
    localUri: `/tmp/uploads/${name}`,
    mimeType: 'application/octet-stream',
    sizeBytes: 1024,
  };
}

function filePart(name: string, mimeType = 'application/octet-stream'): ContentPart {
  return { type: 'file', source: { ...fileRef(name), mimeType } };
}

function fakeUpload(): WechatUploadResult {
  return {
    encryptQueryParam: 'eq',
    aesKey: 'k',
    encryptType: 1,
    encryptedSize: 16,
    rawMd5: 'md5',
    rawSize: 10,
  };
}

function reportCommand(text: string, activity?: string) {
  return genericCommand('report_to_user', { content: [{ type: 'text', text }] }, activity ? { id: activity } : undefined);
}

// ─── Aggregated build (platforms/wechat/message.ts) ──────────────────────────

describe('fromMessagePartsAggregated', () => {
  it('merges mixed parts into a single request with ordered item_list', () => {
    const text = { type: 'text', text: '报告' } as MessageContent;
    const image = { type: 'image', source: fileRef('pic.png') } as MessageContent;
    const file = { type: 'file', source: fileRef('doc.pdf') } as MessageContent;
    const uploadResults = new Map<MessageContent, WechatUploadResult>([
      [image, fakeUpload()],
      [file, fakeUpload()],
    ]);

    const req = fromMessagePartsAggregated('user_a', [text, image, file], 'ctx_1', uploadResults);

    expect(req.msg.item_list).toHaveLength(3);
    expect(req.msg.item_list[0]).toEqual({ type: 1, text_item: { text: '报告' } });
    expect(req.msg.item_list[1]).toMatchObject({ type: 2 });
    expect(req.msg.item_list[2]).toMatchObject({ type: 4, file_item: { file_name: 'doc.pdf' } });
    expect(req.msg.to_user_id).toBe('user_a');
    expect(req.msg.context_token).toBe('ctx_1');
    expect(req.msg.message_type).toBe(2);
    expect(req.base_info).toEqual({ channel_version: '1' });
  });

  it('degrades audio to file_item (upload as file)', () => {
    const audio = { type: 'audio', source: fileRef('voice.mp3') } as MessageContent;
    const uploadResults = new Map<MessageContent, WechatUploadResult>([[audio, fakeUpload()]]);

    const req = fromMessagePartsAggregated('user_b', [audio], 'ctx_2', uploadResults);

    expect(req.msg.item_list).toHaveLength(1);
    expect(req.msg.item_list[0]).toMatchObject({ type: 4, file_item: { file_name: 'voice.mp3' } });
  });
});

// ─── Bridge handler ───────────────────────────────────────────────────────────

describe('Bridge report_to_user', () => {
  let bridge: Bridge;
  const cloudSend = vi.fn<(chatId: ChannelId, content: { type: string; text: string }) => Promise<ReturnType<typeof messageId>>>();
  let cloudMessagesIter: ManualIter<Message>;

  beforeEach(() => {
    vi.clearAllMocks();
    cloudMessagesIter = new ManualIter<Message>();
    cloudSend.mockResolvedValue(messageId('mid-1'));

    const transport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      onRequest: vi.fn(),
    } as unknown as XacppTransport;

    bridge = new Bridge(
      transport,
      {
        cloud: {
          platform: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          send: cloudSend,
          messages: () => cloudMessagesIter.iter(),
          streamCapability: vi.fn(),
          healthCheck: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          refreshTypingIndicator: vi.fn().mockResolvedValue(undefined),
          setTypingIndicator: vi.fn().mockResolvedValue(undefined),
          releaseTypingIndicator: vi.fn().mockResolvedValue(undefined),
        } as never,
      },
    );
  });

  it('limits report_to_user to 5 calls per round with decreasing remaining count', async () => {
    bridge.setSession(mockSession('chat-a'));

    for (let i = 1; i <= 5; i++) {
      const response = await bridge.handleCommand(reportCommand(`report ${i}`, 'act-a'));
      expect(response).toEqual(genericResponse('report_to_user', {
        remaining: 5 - i,
        message: `内容已投递。如果没有其他内容需要呈报，本轮可以就此结束，不必再给出进一步的输出；如仍有内容需要呈报，到下一次用户输入前你还可以报告 ${5 - i} 次`,
      }));
    }

    cloudSend.mockClear();
    const sixth = await bridge.handleCommand(reportCommand('report 6', 'act-a'));
    expect(sixth.kind).toBe('error');
    expect(sixth).toMatchObject({
      code: 'report_limit_reached',
      message: '到下一次用户输入前的报告次数已用完（5 次），请勿继续调用',
    });
    expect(cloudSend).not.toHaveBeenCalled();
  });

  it('intercepts executable file parts, passes png and text through', async () => {
    bridge.setSession(mockSession('chat-a'));

    const response = await bridge.handleCommand(genericCommand('report_to_user', {
      content: [
        { type: 'text', text: '报告' },
        filePart('app.exe'),
        filePart('SETUP.DMG'),
        filePart('photo.png', 'image/png'),
      ],
    }));

    expect(response.kind).toBe('generic');
    expect(cloudSend).toHaveBeenCalledWith(channelId('chat-a'), { type: 'text', text: '报告' });
    expect(cloudSend).toHaveBeenCalledWith(channelId('chat-a'), {
      type: 'text',
      text: '[已拦截可执行文件：app.exe，该类型文件不支持转发]',
    });
    expect(cloudSend).toHaveBeenCalledWith(channelId('chat-a'), {
      type: 'text',
      text: '[已拦截可执行文件：SETUP.DMG，该类型文件不支持转发]',
    });
    // png is not intercepted — forwarded as a file content
    expect(cloudSend).toHaveBeenCalledWith(channelId('chat-a'), {
      type: 'file',
      source: expect.objectContaining({ localUri: '/tmp/uploads/photo.png' }),
    });
    expect(cloudSend).toHaveBeenCalledTimes(4);
  });

  it('resets the call count on xacpp start event', async () => {
    bridge.setSession(mockSession('chat-a'));
    (bridge as unknown as { bindActivity(chatId: ChannelId, senderId: ReturnType<typeof userId>, activityId: string): void })
      .bindActivity(channelId('chat-a'), userId('u1'), 'act-a');

    for (let i = 0; i < 5; i++) {
      await bridge.handleCommand(reportCommand('report', 'act-a'));
    }
    const blocked = await bridge.handleCommand(reportCommand('report', 'act-a'));
    expect(blocked.kind).toBe('error');

    // xacpp start = new round — count resets to zero
    await bridge.handleEvent('act-a', {
      activity: { id: 'act-a' },
      event: { name: 'start', data: {} },
    });

    const response = await bridge.handleCommand(reportCommand('new round', 'act-a'));
    expect(response).toEqual(genericResponse('report_to_user', {
      remaining: 4,
      message: `内容已投递。如果没有其他内容需要呈报，本轮可以就此结束，不必再给出进一步的输出；如仍有内容需要呈报，到下一次用户输入前你还可以报告 4 次`,
    }));
  });

  it('suppresses complete assistantReply when report_to_user already delivered this round', async () => {
    bridge.setSession(mockSession('chat-a'));
    (bridge as unknown as { bindActivity(chatId: ChannelId, senderId: ReturnType<typeof userId>, activityId: string): void })
      .bindActivity(channelId('chat-a'), userId('u1'), 'act-a');

    await bridge.handleCommand(reportCommand('report', 'act-a'));
    cloudSend.mockClear();

    await bridge.handleEvent('act-a', {
      activity: { id: 'act-a' },
      event: { name: 'complete', data: { assistantReply: [{ type: 'text', text: 'final reply' }] } },
    });

    // assistantReply 丢弃：本轮报告已通过 report_to_user 投递，避免双份
    expect(cloudSend).not.toHaveBeenCalled();
  });

  it('delivers complete assistantReply when no report_to_user happened this round', async () => {
    bridge.setSession(mockSession('chat-a'));
    (bridge as unknown as { bindActivity(chatId: ChannelId, senderId: ReturnType<typeof userId>, activityId: string): void })
      .bindActivity(channelId('chat-a'), userId('u1'), 'act-a');

    await bridge.handleEvent('act-a', {
      activity: { id: 'act-a' },
      event: { name: 'complete', data: { assistantReply: [{ type: 'text', text: 'final reply' }] } },
    });

    expect(cloudSend).toHaveBeenCalledWith(channelId('chat-a'), { type: 'text', text: 'final reply' });
  });

  it('returns delivery error when sessionChatId is absent', async () => {
    const response = await bridge.handleCommand(reportCommand('orphan'));
    expect(response.kind).toBe('error');
    expect(response).toMatchObject({ code: 'report_delivery_failed' });
    expect(cloudSend).not.toHaveBeenCalled();
  });

  // ─── B1': interceptor must not crash on missing wire fields ──────────────────

  it('does not crash on file part with missing source (B1)', async () => {
    bridge.setSession(mockSession('chat-a'));

    const parts = [
      { type: 'file' },
      { type: 'file', source: { remoteUrl: 'https://cdn.example.com/payload.exe' } },
      { type: 'file', source: { localUri: '/tmp/virus.bat' } },
      { type: 'file', source: { localUri: '/tmp/doc.pdf' } },
    ] as unknown as ContentPart[];

    let response: XacppResponse;
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response = (bridge as any)._interceptExecutableParts(parts);
    }).not.toThrow();

    // source-less part falls back to 'unknown' name — no executable extension, passes through
    expect(response![0]).toEqual({ type: 'file' });
    // remoteUrl-only .exe is intercepted by extension
    expect(response![1]).toEqual({ type: 'text', text: '[已拦截可执行文件：payload.exe，该类型文件不支持转发]' });
    // localUri-only .bat is intercepted by extension
    expect(response![2]).toEqual({ type: 'text', text: '[已拦截可执行文件：virus.bat，该类型文件不支持转发]' });
    // benign .pdf passes through
    expect(response![3]).toEqual(parts[3]);
  });

  it('does not crash when mimeType is missing or non-string (B1)', async () => {
    bridge.setSession(mockSession('chat-a'));

    const parts = [
      { type: 'file', source: { localUri: '/tmp/app.appimage' } },
      { type: 'file', source: { localUri: '/tmp/ok.txt', mimeType: 12345 } },
    ] as unknown as ContentPart[];

    let response: XacppResponse;
    expect(() => {
      response = (bridge as any)._interceptExecutableParts(parts);
    }).not.toThrow();

    // extension-based interception still works without mimeType
    expect(response![0]).toEqual({ type: 'text', text: '[已拦截可执行文件：app.appimage，该类型文件不支持转发]' });
    // non-string mimeType treated as empty — extension .txt passes through
    expect(response![1]).toEqual(parts[1]);
  });

  it('delivers source-less media part as text fallback without crashing (pipeline end-to-end)', async () => {
    bridge.setSession(mockSession('chat-a'));

    const response = await bridge.handleCommand(
      genericCommand('report_to_user', {
        content: [{ type: 'text', text: 'hi' }, { type: 'image' }, { text: 'no type field' }],
      }) as never,
    );

    // text part delivered; source-less image falls back to [image] text — no throw
    expect(cloudSend).toHaveBeenCalledWith('chat-a', { type: 'text', text: 'hi' });
    expect(cloudSend).toHaveBeenCalledWith('chat-a', { type: 'text', text: '[image]' });
    // type-less but text-bearing part is delivered as text (model may omit type)
    expect(cloudSend).toHaveBeenCalledWith('chat-a', { type: 'text', text: 'no type field' });
    expect(response).toEqual(
      genericResponse('report_to_user', { remaining: 4, message: '内容已投递。如果没有其他内容需要呈报，本轮可以就此结束，不必再给出进一步的输出；如仍有内容需要呈报，到下一次用户输入前你还可以报告 4 次' }),
    );
  });

  it('normalizes simplified media parts ({image|file: path}) into ContentPart with derived source', async () => {
    bridge.setSession(mockSession('chat-a'));

    const response = await bridge.handleCommand(
      genericCommand('report_to_user', {
        content: [{ image: '/tmp/pic.png' }, { file: '/tmp/report.pdf' }],
      }) as never,
    );

    // 归一化：localUri 原样、mimeType 扩展名推导、文件不可读时 sizeBytes=0、file 取 basename 作 name
    expect(cloudSend).toHaveBeenCalledWith('chat-a', {
      type: 'image',
      source: { remoteUrl: '', localUri: '/tmp/pic.png', mimeType: 'image/png', sizeBytes: 0 },
    });
    expect(cloudSend).toHaveBeenCalledWith('chat-a', {
      type: 'file',
      source: { remoteUrl: '', localUri: '/tmp/report.pdf', mimeType: 'application/pdf', sizeBytes: 0 },
      name: 'report.pdf',
    });
    expect(response).toEqual(
      genericResponse('report_to_user', { remaining: 4, message: '内容已投递。如果没有其他内容需要呈报，本轮可以就此结束，不必再给出进一步的输出；如仍有内容需要呈报，到下一次用户输入前你还可以报告 4 次' }),
    );
  });
});

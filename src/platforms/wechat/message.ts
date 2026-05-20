import {
  messageId,
  channelId,
  userId,
  type Message,
  type MessageContent,
} from '../../core/types.js';
import { randomUUID } from 'node:crypto';
import type { WechatUploadResult } from './upload.js';
import { createLogger } from '../../core/logger.js';
import { downloadToBuffer, saveTemp } from '../../core/fs-utils.js';
import { decryptBuffer } from './crypto.js';
const log = createLogger('WechatMessage');

// --------------------------------------------------------------------------
// Weixin message types (iLink bot protocol)
// --------------------------------------------------------------------------

export interface WeixinMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  context_token: string;
  item_list: WeixinMessageItem[];
  message_id?: number;
  msg_id?: string;
  create_time_ms?: number;
}

export type WeixinMessageItem =
  | { type: 1; text_item: { text: string } }
  | { type: 2; image_item: { media: { full_url: string; aes_key?: string } } }
  | { type: 3; voice_item: { media: { full_url: string; aes_key?: string } } }
  | { type: 4; file_item: { file_name?: string; media: { full_url: string; aes_key?: string } } }
  | { type: 5; video_item: { media: { full_url: string; aes_key?: string } } }
  | { type: number; [key: string]: unknown };

export interface WeixinSendMessageBody {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: 2;
  message_state: 2;
  context_token: string;
  item_list: WeixinOutgoingItem[];
}

export interface WeixinMediaPayload {
  media: {
    encrypt_query_param: string;
    aes_key: string;
    encrypt_type: number;
  };
  [key: string]: unknown;
}

export type WeixinOutgoingItem =
  | { type: 1; text_item: { text: string } }
  | { type: 2; image_item: WeixinMediaPayload }
  | { type: 4; file_item: { file_name: string } & WeixinMediaPayload }
  | { type: 5; video_item: WeixinMediaPayload };

export interface WeixinSendRequest {
  msg: WeixinSendMessageBody;
  base_info: { channel_version: string };
}

// --------------------------------------------------------------------------
// Standard MessageContent → Weixin send request
// --------------------------------------------------------------------------

function contentToText(content: MessageContent): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'image': {
      const src = content.source;
      if (src.localUri || src.remoteUrl) return '[image]';
      return '[image 无法发送]';
    }
    case 'audio': {
      const src = content.source;
      if (src.localUri || src.remoteUrl) return '[audio]';
      return '[audio 无法发送]';
    }
    case 'video': {
      const src = content.source;
      if (src.localUri || src.remoteUrl) return '[video]';
      return '[video 无法发送]';
    }
    case 'file': {
      const src = content.source;
      const name = (content.type === 'file' ? content.name : undefined)
        || src.remoteUrl.split('/').pop()
        || src.localUri.split('/').pop()
        || 'unknown';
      if (src.localUri || src.remoteUrl) return `[file: ${name}]`;
      return '[file 无法发送]';
    }
  }
}

export function fromMessageContent(
  toUserId: string,
  content: MessageContent,
  contextToken: string,
): WeixinSendRequest {
  return {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text: contentToText(content) } }],
    },
    base_info: { channel_version: '1' },
  };
}

function buildMediaItem(
  content: Exclude<MessageContent, { type: 'text' }>,
  uploadResult: WechatUploadResult,
): WeixinOutgoingItem {
  const media = {
    media: {
      encrypt_query_param: uploadResult.encryptQueryParam,
      aes_key: uploadResult.aesKey,
      encrypt_type: uploadResult.encryptType,
    },
  };
  switch (content.type) {
    case 'image':
      return { type: 2, image_item: { ...media, mid_size: uploadResult.encryptedSize } };
    case 'video':
      return { type: 5, video_item: { ...media, video_size: uploadResult.encryptedSize } };
    case 'audio':
    case 'file': {
      const name = (content.type === 'file' ? content.name : undefined)
        || content.source.remoteUrl.split('/').pop()
        || content.source.localUri.split('/').pop()
        || 'file';
      return {
        type: 4,
        file_item: {
          file_name: name,
          md5: uploadResult.rawMd5,
          len: String(uploadResult.rawSize),
          ...media,
        },
      };
    }
  }
}

/** Build a WeChat send request with media upload result. */
export function fromMessageContentWithUpload(
  toUserId: string,
  content: MessageContent,
  contextToken: string,
  uploadResult: WechatUploadResult,
): WeixinSendRequest {
  if (content.type === 'text') {
    throw new Error('fromMessageContentWithUpload does not accept text content');
  }
  return {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [buildMediaItem(content, uploadResult)],
    },
    base_info: { channel_version: '1' },
  };
}

// --------------------------------------------------------------------------
// Weixin message → Standard Message
// --------------------------------------------------------------------------

function parseItem(item?: WeixinMessageItem): MessageContent {
  if (!item || item.type !== 1) {
    return { type: 'text', text: '' };
  }
  return { type: 'text', text: (item as { text_item: { text: string } }).text_item.text };
}

export function toStandardMessage(msg: WeixinMessage): Message {
  const id = msg.message_id != null ? String(msg.message_id) : (msg.msg_id ?? String(Date.now()));
  return {
    id: messageId(id),
    chatId: channelId(msg.from_user_id),
    senderId: userId(msg.from_user_id),
    content: parseItem(msg.item_list[0]),
    direction: 'incoming',
  };
}

// --------------------------------------------------------------------------
// Inbound media: download → decrypt → detect → save temp
// --------------------------------------------------------------------------

const TYPE_LABEL: Record<number, string> = {
  2: '图片',
  3: '语音',
  4: '文件',
  5: '视频',
};

export async function processInboundMedia(item: WeixinMessageItem): Promise<MessageContent> {
  if (item.type === 1) {
    return { type: 'text', text: '' };
  }

  let url: string | undefined;
  let aesKey: string | undefined;
  let fileNameHint: string | undefined;

  const raw = item as any;
  switch (item.type) {
    case 2:
      url = raw.image_item?.media?.full_url;
      aesKey = raw.image_item?.media?.aes_key;
      break;
    case 3:
      url = raw.voice_item?.media?.full_url;
      aesKey = raw.voice_item?.media?.aes_key;
      break;
    case 4:
      url = raw.file_item?.media?.full_url;
      aesKey = raw.file_item?.media?.aes_key;
      fileNameHint = raw.file_item?.file_name;
      break;
    case 5:
      url = raw.video_item?.media?.full_url;
      aesKey = raw.video_item?.media?.aes_key;
      break;
    default:
      throw new Error(`未知媒体类型: ${item.type}`);
  }

  const label = TYPE_LABEL[item.type] ?? '媒体';

  if (!url) {
    throw new Error(`${label}接收失败：缺少下载地址`);
  }

  try {
    const encrypted = await downloadToBuffer(url);
    const decrypted = aesKey
      ? decryptBuffer(encrypted, aesKey)
      : encrypted;
    const meta = await saveTemp(decrypted, url, fileNameHint);
    if (!meta.mimeType) {
      throw new Error(`${label}接收失败：无法识别文件类型`);
    }

    const source = {
      localUri: meta.localUri,
      sha256: meta.sha256,
      sizeBytes: meta.sizeBytes,
      mimeType: meta.mimeType,
      requireOrganized: true,
      remoteUrl: url,
    };

    if (item.type === 4) {
      return fileNameHint
        ? { type: 'file', name: fileNameHint, source }
        : { type: 'file', source };
    }

    const contentType = item.type === 2 ? 'image' : item.type === 3 ? 'audio' : 'video';
    return { type: contentType, source };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}接收失败：${reason}`);
  }
}

// --------------------------------------------------------------------------
// Extractors
// --------------------------------------------------------------------------

export function extractContextToken(msg: WeixinMessage): string {
  return msg.context_token;
}

export function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list) {
    if (item.type === 1) {
      return (item as { text_item: { text: string } }).text_item.text;
    }
  }
  return '';
}

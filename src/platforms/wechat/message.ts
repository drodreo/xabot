import {
  messageId,
  channelId,
  userId,
  type Message,
  type MessageContent,
} from '../../core/types.js';
import { randomUUID } from 'node:crypto';
import type { WechatUploadResult } from './upload.js';

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
  | { type: 2; image_item: { cdn: { download_url: string } } }
  | { type: 3; voice_item: { cdn: { download_url: string } } }
  | { type: 4; file_item: { file_name: string; cdn: { download_url: string } } }
  | { type: 5; video_item: { cdn: { download_url: string } } }
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
  if (!item) {
    return { type: 'text', text: '' };
  }
  switch (item.type) {
    case 1:
      return { type: 'text', text: (item as { text_item: { text: string } }).text_item.text };
    case 2:
      return { type: 'image', source: { localUri: '', remoteUrl: (item as { image_item: { cdn: { download_url: string } } }).image_item.cdn.download_url, mimeType: '', sizeBytes: 0 } };
    case 3:
      return { type: 'audio', source: { localUri: '', remoteUrl: (item as { voice_item: { cdn: { download_url: string } } }).voice_item.cdn.download_url, mimeType: '', sizeBytes: 0 } };
    case 4: {
      const fileItem = item as { file_item: { file_name: string; cdn: { download_url: string } } };
      return fileItem.file_item.file_name
        ? { type: 'file', name: fileItem.file_item.file_name, source: { localUri: '', remoteUrl: fileItem.file_item.cdn.download_url, mimeType: '', sizeBytes: 0 } }
        : { type: 'file', source: { localUri: '', remoteUrl: fileItem.file_item.cdn.download_url, mimeType: '', sizeBytes: 0 } };
    }
    case 5:
      return { type: 'video', source: { localUri: '', remoteUrl: (item as { video_item: { cdn: { download_url: string } } }).video_item.cdn.download_url, mimeType: '', sizeBytes: 0 } };
    default:
      return { type: 'text', text: '[unsupported]' };
  }
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

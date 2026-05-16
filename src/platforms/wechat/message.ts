import {
  messageId,
  channelId,
  userId,
  type Message,
  type MessageContent,
} from '../../core/types.js';
import { randomUUID } from 'node:crypto';

// --------------------------------------------------------------------------
// Weixin message types (iLink bot protocol)
// --------------------------------------------------------------------------

export interface WeixinMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  context_token: string;
  item_list: WeixinMessageItem[];
  msg_id?: string;
  create_time?: number;
}

export type WeixinMessageItem =
  | { type: 1; text_item: { text: string } }
  | { type: 2; image_item: { cdn: { download_url: string } } }
  | { type: 4; file_item: { file_name: string; cdn: { download_url: string } } }
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

export type WeixinOutgoingItem = { type: 1; text_item: { text: string } };

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
    case 'image':
      return '[image]';
    case 'file':
      return `[file: ${content.name}]`;
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
      return { type: 'image', url: (item as { image_item: { cdn: { download_url: string } } }).image_item.cdn.download_url };
    case 4:
      return { type: 'file', url: (item as { file_item: { cdn: { download_url: string } } }).file_item.cdn.download_url, name: (item as { file_item: { file_name: string } }).file_item.file_name };
    default:
      return { type: 'text', text: '[unsupported]' };
  }
}

export function toStandardMessage(msg: WeixinMessage): Message {
  return {
    id: messageId(msg.msg_id ?? String(Date.now())),
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

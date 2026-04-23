import {
  messageId,
  channelId,
  userId,
  type Message,
  type MessageContent,
} from '../../core/types.js';

// --------------------------------------------------------------------------
// Wechat event payload (from ilink_bot long-polling API)
// --------------------------------------------------------------------------

export interface WechatMessageEvent {
  msgId?: string;
  fromUserName?: string;
  toUserName?: string;
  msgType?: string;
  content?: string;
  mediaUrl?: string;
  createTime?: number;
  event?: string;
}

// --------------------------------------------------------------------------
// Wechat outgoing message body
// --------------------------------------------------------------------------

export interface WechatOutgoingBody {
  toUser: string;
  msgType: string;
  content: string;
  mediaUrl?: string;
}

// --------------------------------------------------------------------------
// Standard MessageContent → Wechat message body
// --------------------------------------------------------------------------

/** Convert standard MessageContent to Wechat outgoing body content string. */
function contentToWechatBody(content: MessageContent): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'image':
      return content.url;
    case 'file':
      // For files, include name in content as fallback
      return content.name;
  }
}

/** Build a Wechat message body for sending via ilink_bot API. */
export function fromMessageContent(
  toUser: string,
  content: MessageContent,
): WechatOutgoingBody {
  const base = {
    toUser,
    msgType: content.type,
    content: contentToWechatBody(content),
  };
  if (content.type === 'image' || content.type === 'file') {
    return { ...base, mediaUrl: content.url };
  }
  return base;
}

// --------------------------------------------------------------------------
// Wechat event → Standard Message
// --------------------------------------------------------------------------

function parseWechatContent(event: WechatMessageEvent): MessageContent {
  const msgType = event.msgType ?? '';

  switch (msgType) {
    case 'text':
      return { type: 'text', text: event.content ?? '' };
    case 'image':
      return { type: 'image', url: event.mediaUrl ?? event.content ?? '' };
    case 'file':
      return {
        type: 'file',
        url: event.mediaUrl ?? '',
        name: event.content ?? 'unknown',
      };
    default:
      // Fallback: treat unknown types as text with the raw content
      return { type: 'text', text: event.content ?? '' };
  }
}

/**
 * Convert a Wechat message receive event to a standard Message.
 * The chatId is the toUserName (the bot's "chat" with the user).
 * The senderId is the fromUserName.
 */
export function toStandardMessage(event: WechatMessageEvent): Message {
  return {
    id: messageId(event.msgId ?? String(Date.now())),
    chatId: channelId(event.toUserName ?? ''),
    senderId: userId(event.fromUserName ?? ''),
    content: parseWechatContent(event),
    direction: 'incoming',
  };
}

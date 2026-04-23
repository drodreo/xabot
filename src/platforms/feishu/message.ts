import { messageId, channelId, userId, type Message, type MessageContent } from '../../core/types.js';

// --------------------------------------------------------------------------
// Feishu event payload (im.message.receive_v1)
// --------------------------------------------------------------------------

export interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

// --------------------------------------------------------------------------
// Feishu outgoing message body
// --------------------------------------------------------------------------

export interface FeishuMessageBody {
  receive_id: string;
  msg_type: string;
  content: string;
}

// --------------------------------------------------------------------------
// Standard Message → Feishu message body
// --------------------------------------------------------------------------

/** Convert a standard MessageContent to a Feishu message body content string. */
function contentToFeishuBody(content: MessageContent): string {
  switch (content.type) {
    case 'text':
      return JSON.stringify({ text: content.text });
    case 'image':
      return JSON.stringify({ image_key: content.url });
    case 'file':
      return JSON.stringify({ file_key: content.url, file_name: content.name });
  }
}

/** Build a Feishu message body for sending via client.im.message.create(). */
export function fromMessageContent(
  receiveId: string,
  content: MessageContent,
): FeishuMessageBody {
  return {
    receive_id: receiveId,
    msg_type: content.type === 'file' ? 'file' : content.type,
    content: contentToFeishuBody(content),
  };
}

// --------------------------------------------------------------------------
// Feishu event → Standard Message
// --------------------------------------------------------------------------

function parseFeishuContent(
  msgType: string,
  rawContent: string,
): MessageContent {
  switch (msgType) {
    case 'text': {
      try {
        const parsed = JSON.parse(rawContent) as { text?: string };
        return { type: 'text', text: parsed.text ?? '' };
      } catch {
        return { type: 'text', text: rawContent };
      }
    }
    case 'image': {
      try {
        const parsed = JSON.parse(rawContent) as { image_key?: string };
        return { type: 'image', url: parsed.image_key ?? '' };
      } catch {
        return { type: 'image', url: '' };
      }
    }
    case 'file': {
      try {
        const parsed = JSON.parse(rawContent) as { file_key?: string; file_name?: string };
        return {
          type: 'file',
          url: parsed.file_key ?? '',
          name: parsed.file_name ?? 'unknown',
        };
      } catch {
        return { type: 'file', url: '', name: 'unknown' };
      }
    }
    default:
      // Fallback: treat unknown types as text with the raw content
      return { type: 'text', text: rawContent };
  }
}

/**
 * Convert a Feishu message receive event to a standard Message.
 * The chatId is the Feishu chat_id.
 * The senderId is the sender's open_id (preferred) / user_id / union_id.
 */
export function toStandardMessage(event: FeishuMessageEvent): Message {
  const senderId =
    event.sender.sender_id?.open_id ??
    event.sender.sender_id?.user_id ??
    event.sender.sender_id?.union_id ??
    '';

  return {
    id: messageId(event.message.message_id),
    chatId: channelId(event.message.chat_id),
    senderId: userId(senderId),
    content: parseFeishuContent(event.message.message_type, event.message.content),
    direction: 'incoming',
  };
}

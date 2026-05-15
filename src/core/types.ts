/** Standard message types shared across all platforms. */

export type MessageId = string & { readonly __brand: 'MessageId' };
export type ChannelId = string & { readonly __brand: 'ChannelId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type SessionId = string & { readonly __brand: 'SessionId' };

export function messageId(s: string): MessageId { return s as MessageId; }
export function channelId(s: string): ChannelId { return s as ChannelId; }
export function userId(s: string): UserId { return s as UserId; }
export function sessionId(s: string): SessionId { return s as SessionId; }

export enum StreamCapability {
  Streaming = 'streaming',
  NonStreaming = 'non-streaming',
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'file'; url: string; name: string };

export interface Message {
  id: MessageId;
  chatId: ChannelId;
  senderId: UserId;
  content: MessageContent;
  direction: 'incoming' | 'outgoing';
}

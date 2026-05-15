/** xabot — multi-platform bot bridge. Entry point. */

export { FeishuClient } from './platforms/feishu/client.js';
export type { FeishuClientConfig } from './platforms/feishu/client.js';
export { WechatClient } from './platforms/wechat/client.js';
export type { WechatConfig } from './platforms/wechat/client.js';
export { StreamCapability } from './core/types.js';
export type {
  Message,
  MessageContent,
  MessageId,
  ChannelId,
  UserId,
  SessionId,
} from './core/types.js';
export { messageId, channelId, userId, sessionId } from './core/types.js';
export type { PlatformClient } from './core/client.js';
export { XabotEstablishHandler } from './xacpp/establish-handler.js';
export { XabotSessionHandler } from './xacpp/session-handler.js';
export { Bridge } from './bridge/index.js';
export { parseDiscoverArgs, DiscoverArgsSchema } from './config/schema.js';
export type { DiscoverArgs } from './config/schema.js';
export { discover, DiscoverTimeoutError } from './cli/discover.js';

/** xabot — multi-platform bot bridge. Entry point. */

export { Router } from './core/router.js';
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
  AgentId,
} from './core/types.js';
export { messageId, channelId, userId, sessionId, agentId } from './core/types.js';
export type { PlatformClient } from './core/client.js';
export { AcpHandler } from './acp/handler.js';
export type { AgentNotification, PermissionRequest } from './acp/handler.js';
export { AcpSession } from './acp/session.js';
export { parseAcpArgs, AcpArgsSchema, parseDiscoverArgs, DiscoverArgsSchema } from './config/schema.js';
export type { DiscoverArgs } from './config/schema.js';
export { discover, DiscoverTimeoutError } from './cli/discover.js';

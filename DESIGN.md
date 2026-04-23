# xabot — TypeScript 版核心方案设计

> 状态：规划阶段
> 创建时间：2026-04-23 15:09
> 前身：~/projects/xabot-rs（Rust 版）

---

## 一、定位

xabot 是下游 Agent 与云端 IM 之间的桥梁。通过 ACP 协议连接 Agent，通过平台 SDK 连接云端（飞书/微信/Discord 等），实现双向消息路由。

```
云端 IM ←→ xabot ←→ 下游 Agent（ACP）
```

## 二、核心依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@agentclientprotocol/sdk` | latest | ACP 客户端，连接下游 Agent |
| `@larksuite/node-sdk` | latest | 飞书官方 SDK，WebSocket 长连接 + REST API |
| `tsx` | latest | TypeScript 运行时 |
| `zod` | latest | CLI 参数校验 |

## 三、项目结构

```
xabot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI 入口
│   ├── config/
│   │   └── schema.ts         # CLI 参数 schema（zod 校验，不持久化）
│   ├── core/
│   │   ├── types.ts          # 标准消息类型（Message, ChannelId, UserId）
│   │   ├── client.ts         # 平台 Client 接口
│   │   └── router.ts         # 路由表：agent_id ↔ chat_ids
│   ├── acp/
│   │   ├── session.ts        # ACP 连接管理（ClientSideConnection）
│   │   └── handler.ts        # ACP Client 实现
│   ├── platforms/
│   │   ├── feishu/
│   │   │   ├── client.ts     # 飞书 Client 实现
│   │   │   └── message.ts    # 飞书消息 ↔ 标准消息转换
│   │   └── wechat/
│   │       ├── client.ts     # 微信 Client 实现
│   │       └── message.ts    # 微信消息 ↔ 标准消息转换
│   ├── bridge/
│   │   └── index.ts          # Bridge：云端 ↔ ACP 消息路由
│   └── cli/
│       ├── acp.ts            # acp 子命令（启动 Bridge，所有配置通过 CLI 参数传入）
│       ├── listen.ts         # listen 子命令
│       ├── send.ts           # send 子命令
│       └── health.ts         # health 子命令
```

**关键：xabot 不持久化任何配置。** 所有配置（凭据、agent_id、chat_ids）由下游 Agent 启动时通过 CLI 参数传入。

## 四、核心接口设计

### 4.1 平台 Client 接口

```typescript
interface PlatformClient {
  /** 平台标识 */
  readonly platform: string;

  /** 连接到云端 */
  connect(): Promise<void>;

  /** 发送消息到指定 chat_id */
  send(chatId: string, content: MessageContent): Promise<MessageId>;

  /** 流式发送消息片段 */
  sendChunk?(chatId: string, content: MessageContent): Promise<MessageId>;

  /** 消息流（长连接/轮询产生的消息） */
  messages(): AsyncIterable<Message>;

  /** 流式能力 */
  streamCapability(): StreamCapability;

  /** 健康检查 */
  healthCheck(): Promise<void>;

  /** 关闭连接 */
  close(): Promise<void>;
}

enum StreamCapability {
  Streaming = 'streaming',
  NonStreaming = 'non-streaming',
}

interface Message {
  id: MessageId;
  chatId: string;        // 云端对话 ID
  senderId: string;      // 发送者 ID
  content: MessageContent;
  direction: 'incoming' | 'outgoing';
}

type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'file'; url: string; name: string };
```

### 4.2 路由表

```typescript
class Router {
  // agent_id → chat_ids
  private agentToChats: Map<string, string[]>;
  // chat_id → agent_id（反向索引）
  private chatToAgent: Map<string, string>;

  /** 注册 agent 的 chat 列表 */
  register(agentId: string, chatIds: string[]): void;

  /** 根据 chat_id 查找 agent_id */
  resolve(chatId: string): string | undefined;

  /** 根据 agent_id 获取所有 chat_ids */
  chats(agentId: string): string[];
}
```

### 4.3 ACP Session

```typescript
class AcpSession {
  /** 建立 ACP 连接（stdin/stdout） */
  static connect(): Promise<AcpSession>;

  /** 获取或创建 session */
  getOrCreateSession(chatId: string): Promise<SessionId>;

  /** 发送 prompt */
  prompt(sessionId: SessionId, content: ContentBlock[]): Promise<void>;

  /** 获取通知流 */
  notifications(): AsyncIterable<SessionNotification>;

  /** 获取权限请求流 */
  permissionRequests(): AsyncIterable<RequestPermissionRequest>;
}
```

### 4.4 Bridge

```typescript
class Bridge {
  constructor(
    cloud: PlatformClient,
    acp: AcpSession,
    router: Router,
  );

  /** 启动消息循环 */
  run(): Promise<void>;
}
```

## 五、通信模式

| 平台 | 模式 | 端口需求 |
|------|------|---------|
| 飞书 | WebSocket 长连接（SDK 内置） | 无 |
| 微信 | HTTP 长轮询 | 无 |
| Discord | WebSocket gateway | 无 |
| Telegram | HTTP 长轮询 / webhook | 轮询无，webhook 有 |

飞书和微信统一免端口。

## 六、完整时序

### 启动

```
下游 Agent 调用：xabot acp --platform feishu --app-id X --app-secret Y --agent-id Z --chat-ids a,b,c
├─ 所有配置通过 CLI 参数传入，xabot 不持久化任何配置
├─ 平台 Client.connect()（飞书 WebSocket / 微信长轮询）
├─ Router.register(agent_id, chat_ids)
├─ AcpSession.connect()（stdin/stdout）
└─ Bridge.run() → 消息循环
```

### 消息循环

```
云端消息 → chat_id → Router.resolve() → agent_id → ACP prompt
├─ 不匹配 → 丢弃
├─ ACP session 按需创建
└─ Agent 回复 → 用 chat_id 发送到云端
```

## 七、与 xabot-rs 的差异

| | xabot-rs | xabot (TS) |
|---|---------|------------|
| ACP SDK | `agent-client-protocol` crate | `@agentclientprotocol/sdk` |
| 飞书通信 | 自己实现 HTTP webhook | 官方 SDK WebSocket 长连接 |
| 微信通信 | 自己实现长轮询 | 保留长轮询实现 |
| 配置格式 | JSON（自定义） | JSON（zod 校验） |
| 运行时 | tokio | Node.js 事件循环 |
| 类型系统 | Rust 类型 | TypeScript 接口 |

## 八、待确认

1. 微信长轮询 API 的具体协议（ilink_bot 的接口）
2. 配对流程的详细设计（配对码生成/匹配/超时）
3. 是否需要支持多 Agent 同时运行（当前设计支持）
4. Discord / Telegram 的接入优先级

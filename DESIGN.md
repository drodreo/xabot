# xabot — TypeScript 版核心方案设计

> 状态：已迁移至 XACPP
> 创建时间：2026-04-23 15:09
> 前身：~/projects/xabot-rs（Rust 版）

---

## 一、定位

xabot 是下游 Agent 与云端 IM 之间的桥梁。通过 XACPP 协议连接 Agent，通过平台 SDK 连接云端（飞书/微信/Discord 等），实现双向消息路由。

```
云端 IM ←→ xabot ←→ 下游 Agent（XACPP）
```

## 二、核心依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `xacpp` | ^0.3.1 | XACPP 协议实现，连接下游 Agent |
| `@larksuite/node-sdk` | latest | 飞书官方 SDK，WebSocket 长连接 + REST API |
| `zod` | latest | CLI 参数校验 |

## 三、项目结构

```
xabot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # 公共入口
│   ├── config/
│   │   └── schema.ts         # CLI 参数 schema（zod 校验，不持久化）
│   ├── core/
│   │   ├── types.ts          # 标准消息类型（Message, ChannelId, UserId）
│   │   ├── client.ts         # 平台 Client 接口
│   │   ├── error.ts          # 结构化错误类型
│   │   └── pairing.ts        # 配对码流程
│   ├── xacpp/
│   │   ├── establish-handler.ts  # XACPP EstablishHandler 实现
│   │   └── session-handler.ts    # XACPP SessionHandler 实现
│   ├── platforms/
│   │   ├── feishu/
│   │   │   ├── client.ts     # 飞书 Client 实现
│   │   │   └── message.ts    # 飞书消息 ↔ 标准消息转换
│   │   └── wechat/
│   │       ├── client.ts     # 微信 Client 实现
│   │       └── message.ts    # 微信消息 ↔ 标准消息转换
│   ├── bridge/
│   │   └── index.ts          # Bridge：云端 ↔ XACPP 消息路由
│   └── cli/
│       ├── index.ts          # CLI 入口（commander）
│       ├── discover.ts       # discover 子命令
│       ├── listen.ts         # listen 子命令
│       ├── send.ts           # send 子命令
│       ├── health.ts         # health 子命令
│       └── run.ts            # run 子命令（Bridge 模式）
```

**关键：xabot 不持久化任何配置。** 所有配置（凭据、chat_ids）由下游 Agent 启动时通过 CLI 参数传入。

## 四、核心接口设计

### 4.1 平台 Client 接口

```typescript
interface PlatformClient {
  readonly platform: string;
  connect(): Promise<void>;
  send(chatId: string, content: MessageContent): Promise<MessageId>;
  sendChunk?(chatId: string, content: MessageContent): Promise<MessageId>;
  messages(): AsyncIterable<Message>;
  streamCapability(): StreamCapability;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}
```

### 4.2 Bridge

```typescript
class Bridge {
  constructor(cloud: PlatformClient, transport: XacppTransport);
  setSession(session: XacppSession): void;
  handleCommand(command: XacppCommand): Promise<XacppResponse>;
  handleEvent(activityId: string, event: XacppActivityEvent): Promise<XacppResponse>;
  resolvePending(requestId: string, response: XacppResponse): void;
  run(): Promise<void>;
  close(): Promise<void>;
}
```

### 4.3 XACPP 协议层

```
Transport  帧层：JSONL envelope 编解码 + request-response id 关联
  └─ Peer   协议端点：状态机 + establish/session 路由
       └─ Session  逻辑会话：establish 后产生，持有 transport 引用
            └─ Activity  活动上下文：与 chatId 一一对应
                 └─ Event  活动内事件：通过 activity 字段路由
```

- xabot 是 XACPP Responder（被动接受 establish 和事件）
- 下游 Agent 是 Initiator（主动发起 establish）

## 五、通信模式

| 平台 | 模式 | 端口需求 |
|------|------|---------|
| 飞书 | WebSocket 长连接（SDK 内置） | 无 |
| 微信 | HTTP 长轮询 | 无 |

飞书和微信统一免端口。

## 六、完整时序

### 启动

```
下游 Agent 调用：xabot run --platform feishu --app-id X --app-secret Y --chat-ids a,b,c
├─ 所有配置通过 CLI 参数传入，xabot 不持久化任何配置
├─ 平台 Client.connect()（飞书 WebSocket / 微信长轮询）
├─ XacppPeer.connect()（stdin/stdout JSONL）
├─ 等待下游 Agent establish → 获得 Session → 注入 Bridge
└─ Bridge.run() → 云端消息循环
```

### 消息循环

```
云端消息 → chatId → 查找 activityId
├─ 不存在 → session.requestCommand({ new_activity }) → 创建映射
└─ session.requestCommand({ invoke_activity }) → 转发到 Agent

Agent 事件 → activity → 查找 chatId
├─ content_delta/complete → cloud.send()
├─ notify → cloud.send()
├─ action_request → cloud.send() → 阻塞等待云端反馈 → 返回
└─ info/warn/error → 日志输出
```

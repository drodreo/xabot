# xabot 时序图

## 1. 配对流程（一次性，首次使用时执行）

```
┌─────────────────────────────────────────────────────────┐
│  xabot discover --platform feishu                        │
│                 --app-id X --app-secret Y                │
│                                                          │
│  1. 生成配对码（随机 6 位字母数字）                         │
│                                                          │
│  2. 连接云端（WebSocket / 长轮询）                         │
│                                                          │
│  3. 输出配对码到 stdout：                                 │
│     "请在 60 秒内给 bot 发送以下配对码：ABC123"            │
│                                                          │
│  4. 等待消息：                                            │
│     ├─ 收到消息，内容 == 配对码 → 配对成功                 │
│     │   提取 chatId，输出到 stdout，关闭连接               │
│     ├─ 收到消息，内容 != 配对码 → 忽略，继续等             │
│     └─ 超时（60s）未收到正确配对码 → 报错退出              │
│                                                          │
│  用户拿到 chatId 后，用于后续 acp 命令的 --chat-ids 参数   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  方式二：用户手动获取 chatId                               │
│  ├─ 飞书：通过飞书开放平台 API / 管理后台获取               │
│  ├─ 微信：通过 ilink_bot 管理接口获取                      │
│  └─ 拿到 chatId 后直接用于 acp 命令                       │
└─────────────────────────────────────────────────────────┘
```

## 2. 启动时序

```
下游 Agent
    │
    ├─ 启动 xabot acp --platform feishu --app-id X --app-secret Y --agent-id Z --chat-ids a,b,c
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ xabot CLI (index.ts)                                     │
│                                                          │
│  1. parseAcpArgs(argv) ──→ zod 校验 ──→ AcpArgs          │
│                                                          │
│  2. 创建 Router                                           │
│     router.register(agentId, chatIds)                    │
│                                                          │
│  3. 创建 PlatformClient（根据 platform 参数）              │
│     ┌─────────────────────────────────────┐              │
│     │ platform=feishu → FeishuClient      │              │
│     │   connect() → WebSocket 长连接       │              │
│     │   SDK: @larksuite/node-sdk          │              │
│     │                                     │              │
│     │ platform=wechat → WechatClient      │              │
│     │   connect() → HTTP 长轮询           │              │
│     └─────────────────────────────────────┘              │
│                                                          │
│  4. 配对验证                                              │
│     对每个 chatId：                                        │
│     cloud.getChat(chatId) 验证 bot 有权访问               │
│     ├─ 验证通过 → 继续                                    │
│     └─ 验证失败 → 报错退出，提示：                         │
│        "chatId xxx 无法访问，请先完成配对：                 │
│         1. 确认 bot 已拉进群/已关注                        │
│         2. 运行 xabot discover 获取正确的 chatId"         │
│                                                          │
│  5. 创建 AcpSession                                       │
│     AcpSession.connect()                                 │
│     └─ stdin/stdout ←→ ACP SDK                           │
│                                                          │
│  6. 创建 Bridge(cloud, acp, router)                       │
│     bridge.run() ──→ 进入消息循环                          │
└─────────────────────────────────────────────────────────┘
```

## 3. 云端 → Agent 消息时序

```
飞书/微信                        xabot                          下游 Agent
    │                               │                               │
    ├─ 用户发消息 ──────────────────→│                               │
    │                               │                               │
    │                    PlatformClient.messages()                   │
    │                    收到 Message { chatId, content }            │
    │                               │                               │
    │                    router.resolve(chatId)                      │
    │                    └─ 不匹配 → 丢弃                            │
    │                    └─ 匹配 → agentId                          │
    │                               │                               │
    │                    acpSession.getOrCreateSession(chatId)       │
    │                    └─ 已有 → 复用 SessionId                    │
    │                    └─ 没有 → 创建新 session                    │
    │                               │                               │
    │                    acpSession.prompt(sessionId, content)       │
    │                               ├──────────────────────────────→│
    │                               │                               │
```

## 4. Agent → 云端 消息时序

```
飞书/微信                        xabot                          下游 Agent
    │                               │                               │
    │                               │←── ACP notification ──────────┤
    │                               │    { sessionId, content }     │
    │                               │                               │
    │                    router.chats(agentId)                       │
    │                    └─ 返回 chatId[]                            │
    │                               │                               │
    │                    对每个 chatId：                              │
    │                    cloud.send(chatId, content)                 │
    │                               │                               │
    │←──────────────────────────────┤                               │
    │                               │                               │
```

## 5. 权限请求时序

```
xabot                           下游 Agent
    │                               │
    │←── ACP permission request ────┤
    │    { sessionId, name,         │
    │      options: [allow,deny] }  │
    │                               │
    │  自动批准 / 交互式审批（待定）   │
    │                               │
    │── permission response ───────→│
    │                               │
```

## 6. 组件关系图

```
┌──────────────────────────────────────────────────────────┐
│                    xabot CLI                              │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │  schema  │  │  Router  │  │ AcpHandler│               │
│  │  (zod)   │  │ (路由表) │  │ (通知队列)│               │
│  └──────────┘  └────┬─────┘  └──────────┘               │
│                     │                                    │
│  ┌──────────────────┼──────────────────────┐             │
│  │                  │                      │             │
│  │  ┌───────────────▼──────────────┐       │             │
│  │  │         Bridge               │       │             │
│  │  │  cloud ←→ router ←→ acp     │       │             │
│  │  └──────┬──────────────┬───────┘       │             │
│  │         │              │               │             │
│  │  ┌──────▼──────┐ ┌────▼────────┐      │             │
│  │  │ FeishuClient│ │ AcpSession  │      │             │
│  │  │ (WebSocket) │ │ (stdin/out) │      │             │
│  │  └─────────────┘ └─────────────┘      │             │
│  │                                        │             │
│  │  ┌─────────────┐                      │             │
│  │  │ WechatClient│                      │             │
│  │  │ (长轮询)     │                      │             │
│  │  └─────────────┘                      │             │
│  └───────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

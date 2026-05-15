# xabot Sequence Diagrams

## 1. Pairing Flow (one-time, executed on first use)

```
┌─────────────────────────────────────────────────────────┐
│  xabot discover --platform feishu                        │
│                 --app-id X --app-secret Y                │
│                                                          │
│  1. Generate pairing code (random 6-char alphanumeric)   │
│                                                          │
│  2. Connect to cloud (WebSocket / long-polling)          │
│                                                          │
│  3. Output pairing code to stdout:                       │
│     "Send the following pairing code to the bot          │
│      within 60 seconds: ABC123"                          │
│                                                          │
│  4. Wait for message:                                    │
│     ├─ Received message, content == pairing code         │
│     │   → pairing successful                             │
│     │   Extract chatId, output to stdout, close          │
│     │   connection                                       │
│     ├─ Received message, content != pairing code         │
│     │   → ignore, keep waiting                           │
│     └─ Timeout (60s) without correct pairing code        │
│         → error exit                                     │
│                                                          │
│  After obtaining chatId, use it for subsequent acp       │
│  command --chat-ids argument                             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Method 2: Manual chatId retrieval                       │
│  ├─ Feishu: Via Feishu Open Platform API / admin console │
│  ├─ WeChat: Via ilink_bot admin interface                │
│  └─ Use chatId directly for acp commands                 │
└─────────────────────────────────────────────────────────┘
```

## 2. Startup Sequence

```
Downstream Agent
    │
    ├─ Start xabot acp --platform feishu --app-id X --app-secret Y --agent-id Z --chat-ids a,b,c
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ xabot CLI (index.ts)                                     │
│                                                          │
│  1. parseAcpArgs(argv) ──→ zod validation ──→ AcpArgs    │
│                                                          │
│  2. Create Router                                        │
│     router.register(agentId, chatIds)                    │
│                                                          │
│  3. Create PlatformClient (based on platform parameter)  │
│     ┌─────────────────────────────────────┐              │
│     │ platform=feishu → FeishuClient      │              │
│     │   connect() → WebSocket connection   │              │
│     │   SDK: @larksuite/node-sdk          │              │
│     │                                     │              │
│     │ platform=wechat → WechatClient      │              │
│     │   connect() → HTTP long-polling     │              │
│     └─────────────────────────────────────┘              │
│                                                          │
│  4. Pairing verification                                 │
│     For each chatId:                                     │
│     cloud.getChat(chatId) verify bot has access          │
│     ├─ Verification passed → continue                    │
│     └─ Verification failed → error exit, hint:           │
│        "chatId xxx inaccessible, please complete         │
│         pairing first:                                   │
│         1. Confirm bot has been added to group /         │
│            followed                                      │
│         2. Run xabot discover to get the correct         │
│            chatId"                                       │
│                                                          │
│  5. Create AcpSession                                    │
│     AcpSession.connect()                                 │
│     └─ stdin/stdout ←→ ACP SDK                           │
│                                                          │
│  6. Create Bridge(cloud, acp, router)                    │
│     bridge.run() ──→ enter message loop                  │
└─────────────────────────────────────────────────────────┘
```

## 3. Cloud → Agent Message Sequence

```
Feishu/WeChat                    xabot                      Downstream Agent
    │                               │                               │
    ├─ User sends message ─────────→│                               │
    │                               │                               │
    │                    PlatformClient.messages()                   │
    │                    Received Message { chatId, content }        │
    │                               │                               │
    │                    router.resolve(chatId)                      │
    │                    └─ No match → discard                       │
    │                    └─ Match → agentId                          │
    │                               │                               │
    │                    acpSession.getOrCreateSession(chatId)       │
    │                    └─ Exists → reuse SessionId                 │
    │                    └─ Not found → create new session           │
    │                               │                               │
    │                    acpSession.prompt(sessionId, content)       │
    │                               ├──────────────────────────────→│
    │                               │                               │
```

## 4. Agent → Cloud Message Sequence

```
Feishu/WeChat                    xabot                      Downstream Agent
    │                               │                               │
    │                               │←── ACP notification ──────────┤
    │                               │    { sessionId, content }     │
    │                               │                               │
    │                    router.chats(agentId)                       │
    │                    └─ return chatId[]                          │
    │                               │                               │
    │                    For each chatId:                            │
    │                    cloud.send(chatId, content)                 │
    │                               │                               │
    │←──────────────────────────────┤                               │
    │                               │                               │
```

## 5. Permission Request Sequence

```
xabot                           Downstream Agent
    │                               │
    │←── ACP permission request ────┤
    │    { sessionId, name,         │
    │      options: [allow,deny] }  │
    │                               │
    │  Auto-approve / interactive approval (TBD)                   │
    │                               │
    │── permission response ───────→│
    │                               │
```

## 6. Component Relationship Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    xabot CLI                              │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │  schema  │  │  Router  │  │ AcpHandler│               │
│  │  (zod)   │  │ (routing │  │ (notify  │               │
│  │          │  │  table)  │  │  queue)  │               │
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
│  │  │ (long-      │                      │             │
│  │  │  polling)   │                      │             │
│  │  └─────────────┘                      │             │
│  └───────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

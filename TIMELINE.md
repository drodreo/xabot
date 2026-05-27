# xabot Sequence Diagrams

This document describes the runtime architecture and message flows of the xabot system.

## 1. Component Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           xabot CLI                                 │
│  ┌────────────────┐           ┌────────────────┐                  │
│  │   feishu.ts    │           │   wechat.ts    │                  │
│  │  --app-id      │           │  --token       │                  │
│  │  --app-secret  │           │  --base-url    │                  │
│  │  --log-level   │           │  --log-level   │                  │
│  └───────┬────────┘           └───────┬────────┘                  │
│          │                              │                            │
│          └──────────┬───────────────────┘                            │
│                     ▼                                                │
│         ┌───────────────────────┐                                    │
│         │    StdioTransport     │                                    │
│         │    (stdin / stdout)   │                                    │
│         └───────────┬───────────┘                                    │
│                     ▼                                                │
│         ┌───────────────────────┐                                    │
│         │  XabotEstablishHandler│                                   │
│         │  - loginFn (WeChat)   │                                   │
│         │  - ensureCloudFn      │                                   │
│         │  - pendingChallenge   │                                   │
│         └───────────┬───────────┘                                    │
│                     ▼                                                │
│         ┌───────────────────────┐                                    │
│         │      XacppPeer       │                                    │
│         │  (XACPP Protocol)     │                                    │
│         └───────────┬───────────┘                                    │
│                     ▼                                                │
│         ┌───────────────────────┐                                    │
│         │       Bridge          │                                    │
│         │  - transport          │◄──── StdioTransport              │
│         │  - cloud (optional)   │◄──── FeishuClient / WechatClient │
│         │  - session            │◄──── XacppSession                │
│         │  - pendingQueues      │                                    │
│         └───────────┬───────────┘                                    │
│                     │                                                │
│     ┌───────────────┼───────────────┐                                │
│     ▼               ▼               ▼                                │
│ ┌────────┐   ┌───────────┐   ┌────────────┐                        │
│ │Feishu  │   │ Platform  │   │Downstream  │                        │
│ │Client  │   │  Client   │   │  Agent     │                        │
│ │        │   │(interface)│   │(via XACPP) │                        │
│ └────────┘   └───────────┘   └────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. CLI Startup Sequence

### 2.1 Feishu `run` Startup

```
User                    CLI                      FeishuClient         XacppPeer         Bridge
 │                      │                           │                   │                │
 │  xabot feishu run    │                           │                   │                │
 │  --app-id X          │                           │                   │                │
 │  --app-secret Y     │                           │                   │                │
 ├─────────────────────→│                           │                   │                │
 │                      │                           │                   │                │
 │                      │  new FeishuClient(X,Y)     │                   │                │
 │                      ├──────────────────────────→│                   │                │
 │                      │                           │                   │                │
 │                      │  cloud.connect()          │                   │                │
 │                      ├──────────────────────────→│                   │                │
 │                      │                           │                   │                │
 │                      │  new StdioTransport       │                   │                │
 │                      │  new XabotEstablishHandler│                   │                │
 │                      │  new XacppPeer            │                   │                │
 │                      │  new Bridge(transport)   │                   │                │
 │                      │                           │                   │                │
 │                      │  setBridge(bridge)        │                   │                │
 │                      ├──────────────────────────────────────────────┤
 │                      │                           │                   │                │
 │                      │  setEstablishHandler(hndlr)│                  │                │
 │                      ├───────────────────────────┼─────────────────→│
 │                      │                           │                   │                │
 │                      │  onEstablished = async →  │                   │                │
 │                      │    create XacppSession    │                   │                │
 │                      │    setSession(session)     │                   │                │
 │                      │    markEstablished()       │                   │                │
 │                      │                           │                   │                │
 │                      │  bridge.run()              │                   │                │
 │                      ├──────────────────────────────────────────────┤
 │                      │                           │              (background loop)
 │                      │                           │                   │                │
 │                      │  peer.connect()            │                   │                │
 │                      ├───────────────────────────┼─────────────────→│
 │                      │                           │              (XACPP handshake)
 │                      │                           │                   │                │
 │                      │  await run(bridge, peer)   │                   │                │
 │                      │                           │                   │                │
 │◄─────────────────────│  Ready (SIGINT/SIGTERM graceful shutdown)    │                │
```

### 2.2 WeChat `run` Startup

```
User                    CLI                      WechatClient         XacppPeer         Bridge
 │                      │                           │                   │                │
 │  xabot wechat run    │                           │                   │                │
 │  --token T           │                           │                   │                │
 │  --base-url B        │                           │                   │                │
 ├─────────────────────→│                           │                   │                │
 │                      │                           │                   │                │
 │                      │  new StdioTransport       │                   │                │
 │                      │  new XabotEstablishHandler│                   │                │
 │                      │  new XacppPeer            │                   │                │
 │                      │  new Bridge(transport)    │                   │                │
 │                      │  (NO cloud yet)           │                   │                │
 │                      │                           │                   │                │
 │                      │  setBridge(bridge)        │                   │                │
 │                      ├──────────────────────────────────────────────┤
 │                      │                           │                   │                │
 │                      │  setEstablishHandler      │                   │                │
 │                      ├───────────────────────────┼─────────────────→│
 │                      │                           │                   │                │
 │                      │  setLoginFn(() => login()) │                  │                │
 │                      │  (QR code login)          │                   │                │
 │                      │                           │                   │                │
 │                      │  setEnsureCloudFn(token,url)→                 │
 │                      │    create WechatClient    │                   │                │
 │                      │    connect()              │                   │                │
 │                      │    bridge.replaceCloud()  │                   │                │
 │                      │                           │                   │                │
 │                      │  onEstablished = async →  │                   │                │
 │                      │    create XacppSession    │                   │                │
 │                      │    setSession(session)    │                   │                │
 │                      │    markEstablished()      │                   │                │
 │                      │                           │                   │                │
 │                      │  bridge.run()              │                   │                │
 │                      │  (waits on cloudReady)    │                   │                │
 │                      ├──────────────────────────────────────────────┤
 │                      │                           │              (background loop)
 │                      │                           │                   │                │
 │                      │  peer.connect()            │                   │                │
 │                      ├───────────────────────────┼─────────────────→│
 │                      │                           │              (XACPP handshake)
 │                      │                           │                   │                │
 │                      │  await run(bridge, peer)  │                   │                │
 │                      │                           │                   │                │
 │◄─────────────────────│  Ready                    │                   │                │
```

## 3. XACPP Three-way Handshake

The handshake establishes a secure channel between the Bridge and the Downstream Agent.

### 3.1 Credentials Path

When credentials are provided, no challenge is needed — `onEstablish()` returns `established` directly.

**WeChat (JSON credentials with botToken):**

```
Downstream                 XacppPeer        XabotEstablishHandler           Bridge
  Agent                      │                     │                        │
   │                         │                     │                        │
   │                         │  onEstablish()      │                        │
   │                         │  credentials =      │                        │
   │                         │    JSON{botToken,   │                        │
   │                         │         baseUrl}    │                        │
   │                         ├────────────────────→│                        │
   │                         │                     │                        │
   │                         │  ensureCloudFn(     │                        │
   │                         │    botToken, baseUrl)│                        │
   │                         │  → WechatClient     │                        │
   │                         │  → connect()        │                        │
   │                         │  → bridge.replace-  │                        │
   │                         │    Cloud(client)    │                        │
   │                         │                     ├───────────────────────→│
   │                         │                     │                        │
   │                         │  createSession()    │                        │
   │                         │  → { type:          │                        │
   │                         │       'established',│                        │
   │                         │     sessionId,      │                        │
   │                         │     handler,        │                        │
   │                         │     credentials }   │                        │
   │                         │←────────────────────│                        │
   │                         │                     │                        │
   │                         │  onEstablished →    │                        │
   │                         │    XacppSession     │                        │
   │                         │    bridge.setSession│                        │
   │                         │    markEstablished()│                        │
   │                         │                     ├───────────────────────→│
   │                         │                     │                        │
```

**Feishu (plain chatId string):** Same flow but `credentials` is a plain chatId — no `ensureCloudFn` call since cloud is already connected at startup.

### 3.2 Challenge Path (Feishu)

No credentials, no loginFn. Cloud is already connected.

```
XacppPeer              XabotEstablishHandler              Bridge
   │                         │                               │
   │  onEstablish()          │                               │
   │  (no credentials)       │                               │
   ├────────────────────────→│                               │
   │                         │                               │
   │  [await submitChallenge]│                               │
   │                         │                               │
   │                         │  Bridge._run() Phase 1:       │
   │                         │  scan cloud messages           │
   │                         │  for challenge text            │
   │                         │                               │
   │                         │  ┌─────────────────────────┐ │
   │                         │  │ User receives challenge  │ │
   │                         │  │ (shown by Initiator),    │ │
   │                         │  │ manually forwards it     │ │
   │                         │  │ to the bot via Feishu    │ │
   │                         │  └─────────────────────────┘ │
   │                         │                               │
   │                         │  submitChallenge(text,chatId) │
   │                         │◄──────────────────────────────┤
   │                         │                               │
   │  { type:                │                               │
   │    'challenge_required',│                               │
   │    challenge }          │                               │
   │←────────────────────────│                               │
   │                         │                               │
   │  Initiator verifies     │                               │
   │  challenge match        │                               │
   │                         │                               │
   │  onEstablishConfirm()   │                               │
   ├────────────────────────→│                               │
   │                         │                               │
   │                         │  credentials = chatId         │
   │                         │  (plain string)               │
   │                         │  createSession()               │
   │                         │                               │
   │  onEstablished →        │                               │
   │  XacppSession           │                               │
   │  bridge.setSession()    │                               │
   │  bridge.markEstablished │──────────────────────────────→│
   │                         │                               │
```

### 3.3 Challenge Path (WeChat - QR login required)

No credentials, loginFn exists. Cloud is NOT connected yet.

```
XacppPeer              XabotEstablishHandler              Bridge
   │                         │                               │
   │  onEstablish()          │                               │
   │  (no credentials)       │                               │
   ├────────────────────────→│                               │
   │                         │                               │
   │                         │  loginFn()                    │
   │                         │  → QR code displayed          │
   │                         │  → user scans QR              │
   │                         │  → { token, baseUrl }         │
   │                         │                               │
   │                         │  ensureCloudFn(token,baseUrl) │
   │                         │  → WechatClient(cfg)          │
   │                         │  → client.connect()           │
   │                         │  → bridge.replaceCloud()      │
   │                         ├──────────────────────────────→│
   │                         │                               │
   │                         │  [await submitChallenge]      │
   │                         │                               │
   │                         │  ┌─────────────────────────┐ │
   │                         │  │ User receives challenge  │ │
   │                         │  │ (shown by Initiator),    │ │
   │                         │  │ manually forwards it     │ │
   │                         │  │ to the bot via WeChat    │ │
   │                         │  └─────────────────────────┘ │
   │                         │                               │
   │                         │  submitChallenge(text,chatId) │
   │                         │◄──────────────────────────────┤
   │                         │                               │
   │  { type:                │                               │
   │    'challenge_required',│                               │
   │    challenge }          │                               │
   │←────────────────────────│                               │
   │                         │                               │
   │  onEstablishConfirm()   │                               │
   ├────────────────────────→│                               │
   │                         │                               │
   │                         │  credentials = JSON{          │
   │                         │    botToken, baseUrl, chatId  │
   │                         │  }                            │
   │                         │  createSession()               │
   │                         │                               │
   │  onEstablished →        │                               │
   │  XacppSession           │                               │
   │  bridge.setSession()    │                               │
   │  bridge.markEstablished │──────────────────────────────→│
   │                         │                               │
```

## 4. Cloud to Agent Message Flow

```
User              PlatformClient              Bridge              XacppSession      Downstream
 │                     │                        │                     │               Agent
 │                     │                        │                     │                │
 │  Send message      │                        │                     │                │
 │  "Hello"           │                        │                     │                │
 │→──────────────────→│                        │                     │                │
 │                     │                        │                     │                │
 │                     │  messages() iterates  │                     │                │
 │                     │  Message{chatId,       │                     │                │
 │                     │         content,       │                     │                │
 │                     │         senderId,      │                     │                │
 │                     │         fallback?}     │                     │                │
 │                     ├──────────────────────→│                     │                │
 │                     │                        │                     │                │
 │                     │                        │  Phase 1: pre-estab │                │
 │                     │                        │  → scan for challenge
 │                     │                        │  (if no match)      │
 │                     │                        │                     │                │
 │                     │                        │  Phase 2: post-estab │                │
 │                     │                        │  parseInput(msg)    │
 │                     │                        │                     │                │
 │                     │                        │  plain text flow:   │                │
 │                     │                        │    check pendingQueue│                │
 │                     │                        │    if pending →     │                │
 │                     │                        │      tryParsePending│                │
 │                     │                        │    else →           │                │
 │                     │                        │      resolve/create │                │
 │                     │                        │        activity    │                │
 │                     │                        │                     │                │
 │                     │                        │  /new [prompt] →    │                │
 │                     │                        │    unbindActivity   │                │
 │                     │                        │    requestCommand   │                │
 │                     │                        │    {new_activity}   │                │
 │                     │                        │    bindActivity     │                │
 │                     │                        │    invoke_activity  │                │
 │                     │                        │                     │                │
 │                     │                        │  invoke_activity:   │                │
 │                     │                        │    setTypingIndicator│               │
 │                     │                        │    requestCommand    │               │
 │                     │                        │    {invoke_activity,│                │
 │                     │                        │     activityId,     │                │
 │                     │                        │     contentParts,  │                │
 │                     │                        │     messageId}     │                │
 │                     │                        ├─────────────────────→│                │
 │                     │                        │                     │──── XACPP ────→│
 │                     │                        │                     │                │
 │                     │                        │                     │                │
 │                     │                        │  Non-text / fallback│                │
 │                     │                        │  messages buffered  │                │
 │                     │                        │  to pendingMediaByTarget│              │
 │                     │                        │                     │                │
```

### 4.1 Media Handling

```
User              PlatformClient              Bridge
 │                     │                        │
 │  Send image        │                        │
 │→──────────────────→│                        │
 │                     │                        │
 │                     │  Message{type:image,   │
 │                     │         source:FileRef}│
 │                     ├──────────────────────→│
 │                     │                        │
 │                     │                        │  buffer to pendingMediaByTarget
 │                     │                        │  Key: chatId:senderId
 │                     │                        │
 │  Send text "desc"  │                        │
 │→──────────────────→│                        │
 │                     │                        │
 │                     │  Message{type:text}    │
 │                     ├──────────────────────→│
 │                     │                        │
 │                     │                        │  invoke_activity
 │                     │                        │  (includes buffered media)
 │                     │                        │                        │
```

## 5. Agent to Cloud Message Flow

All events originate from the Downstream Agent and are routed through Bridge to PlatformClient.
The key difference between platforms is how text content is delivered.

### 5.1 Feishu (Streaming)

Feishu supports streaming — `content_delta` events are forwarded in real time.

```
Downstream              Bridge              PlatformClient            User
  Agent                   │                        │                    │
   │                      │                        │                    │
   │  Event: think        │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  track thinkingStart   │                    │
   │                      │  verbose → cloud.send  │                    │
   │                      │  "💭 正在思考..."       │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: tool_use     │                        │                    │
   │  { toolName }        │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  track toolActiveStart │                    │
   │                      │  verbose → cloud.send  │                    │
   │                      │  "🔧 行动中..."        │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  refreshTypingIndicator│                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: pair_complete│                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  cleanup toolActive    │                    │
   │                      │  Start                 │                    │
   │                      │                        │                    │
   │  Event: content_    │                        │                    │
   │    delta (1st)       │                        │                    │
   │  { payload: "Hello" }│                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  check streamCapability│                    │
   │                      │  = Streaming ✓         │                    │
   │                      │                        │                    │
   │                      │  cloud.send            │                    │
   │                      │  "正在组织表达..."      │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  _sendContentPart      │                    │
   │                      │  cloud.send(text)      │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  refreshTypingIndicator│                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: content_    │                        │                    │
   │    delta (nth)       │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  _sendContentPart      │                    │
   │                      │  cloud.send(text)      │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: complete     │                        │                    │
   │  { assistantReply:   │                        │                    │
   │    [ContentPart...] }│                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  releaseTypingIndicator│                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  for each part in      │                    │
   │                      │  assistantReply:       │                    │
   │                      │    _sendContentPart    │                    │
   │                      │    cloud.send()        │                    │
   │                      ├───────────────────────→│──────────────────→│
   │                      │                        │                    │
```

### 5.2 WeChat (Non-Streaming)

WeChat is non-streaming — `content_delta` events are silently dropped. Content arrives via
`complete.assistantReply`. `content_part` is only forwarded in verbose mode.

```
Downstream              Bridge              PlatformClient            User
  Agent                   │                        │                    │
   │                      │                        │                    │
   │  Event: think        │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  track thinkingStart   │                    │
   │                      │  verbose → cloud.send  │                    │
   │                      │  "💭 正在思考..."       │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: tool_use     │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  verbose → cloud.send  │                    │
   │                      │  "🔧 行动中..."        │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: content_    │                        │                    │
   │    delta             │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  streamCapability =    │                    │
   │                      │  NonStreaming → skip   │                    │
   │                      │                        │                    │
   │  Event: content_part │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  verbose →             │                    │
   │                      │    _sendContentPart    │                    │
   │                      │  !verbose → skip       │                    │
   │                      │                        │                    │
   │  Event: tool_result  │                        │                    │
   │  { toolName, parts } │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  if toolName ===       │                    │
   │                      │  'send_message':       │                    │
   │                      │    for each part:      │                    │
   │                      │      _sendContentPart  │                    │
   │                      │      cloud.send()      │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │  Event: complete     │                        │                    │
   │  { assistantReply:   │                        │                    │
   │    [ContentPart...] }│                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  releaseTypingIndicator│                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  for each part in      │                    │
   │                      │  assistantReply:       │                    │
   │                      │    _sendContentPart    │                    │
   │                      │    cloud.send()        │                    │
   │                      ├───────────────────────→│──────────────────→│
   │                      │                        │                    │
```

## 6. Pending Interaction Flow

### 6.1 Action Request

```
Downstream              Bridge              PlatformClient            User
  Agent                   │                        │                    │
   │                      │                        │                    │
   │  Event: action_      │                        │                    │
   │  request             │                        │                    │
   │  { requestId,        │                        │                    │
   │    toolName,         │                        │                    │
   │    intent, alert }   │                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  formatActionMessage() │                    │
   │                      │  send to cloud:        │                    │
   │                      │  "🔴 [Authorization    │                    │
   │                      │   Request] intent      │                    │
   │                      │   Tool: toolName       │                    │
   │                      │   ───────────────      │                    │
   │                      │   a: 始终允许          │                    │
   │                      │   y: 单次允许          │                    │
   │                      │   n [原因]: 本次拒绝   │                    │
   │                      │   c: 取消执行"         │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  enter pendingQueue    │                    │
   │                      │  (await user reply     │                    │
   │                      │   via cloud message)   │                    │
   │                      │                        │                    │
   │                      │                        │  Reply: "a"        │
   │                      │                        │  (approve always)  │
   │                      │  cloud message         │←──────────────────│
   │                      │◄───────────────────────┤                    │
   │                      │                        │                    │
   │                      │  tryParsePendingResp:  │                    │
   │                      │  "a" → approve_always  │                    │
   │                      │                        │                    │
   │                      │  resolvePending()      │                    │
   │                      │  response:             │                    │
   │                      │  { kind: 'action',     │                    │
   │                      │    type: 'approve_     │                    │
   │                      │    always',            │                    │
   │                      │    requestId }         │                    │
   │  XacppResponse       │                        │                    │
   │←─────────────────────│                        │                    │
   │                      │                        │                    │
```

### 6.2 Question

```
Downstream              Bridge              PlatformClient            User
  Agent                   │                        │                    │
   │                      │                        │                    │
   │  Event: question     │                        │                    │
   │  { requestId,        │                        │                    │
   │    question: 'Save?' │                        │                    │
   │    options: ['y','n']}                        │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  formatQuestionMessage()                    │
   │                      │  send to cloud:        │                    │
   │                      │  "❓ [Question] Save?   │                    │
   │                      │   Options:             │                    │
   │                      │     1. y               │                    │
   │                      │     2. n               │                    │
   │                      │   ───────────────      │                    │
   │                      │   回复 1~2 选择选项    │                    │
   │                      │   c: 取消执行"         │                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  enter pendingQueue    │                    │
   │                      │                        │                    │
   │                      │                        │  Reply: "1"        │
   │                      │                        │  (select option 1) │
   │                      │  cloud message         │←──────────────────│
   │                      │◄───────────────────────┤                    │
   │                      │                        │                    │
   │                      │  tryParsePendingResp:  │                    │
   │                      │  "1" → answer:         │                    │
   │                      │  options[0] = "y"      │                    │
   │                      │                        │                    │
   │                      │  resolvePending()      │                    │
   │                      │  response:             │                    │
   │                      │  { kind: 'question',   │                    │
   │                      │    type: 'answer',     │                    │
   │                      │    content: 'y' }      │                    │
   │  XacppResponse       │                        │                    │
   │←─────────────────────│                        │                    │
   │                      │                        │                    │
```

### 6.3 Sensitive Info Operation

```
Downstream              Bridge              PlatformClient            User
  Agent                   │                        │                    │
   │                      │                        │                    │
   │  Event: sensitive_   │                        │                    │
   │  info_operation      │                        │                    │
   │  { requestId,        │                        │                    │
   │    operation: {      │                        │                    │
   │      type: 'collect',│                        │                    │
   │      items: [{       │                        │                    │
   │        key, siType,  │                        │                    │
   │        displayText }]}│                       │                    │
   │─────────────────────→│                        │                    │
   │                      │                        │                    │
   │                      │  formatSensitiveInfo-  │                    │
   │                      │  Message()             │                    │
   │                      │  send to cloud:        │                    │
   │                      │  "🔒 [Sensitive Info   │                    │
   │                      │   Operation] collect   │                    │
   │                      │   Items:               │                    │
   │                      │     1. displayText(x)  │                    │
   │                      │   ───────────────      │                    │
   │                      │   逐行回复值 | t: 取消"│                    │
   │                      ├───────────────────────→│                    │
   │                      │                        │                    │
   │                      │  enter pendingQueue    │                    │
   │                      │                        │                    │
   │                      │                        │  Reply: lines...   │
   │                      │                        │  (one per item)    │
   │                      │  cloud message         │←──────────────────│
   │                      │◄───────────────────────┤                    │
   │                      │                        │                    │
   │                      │  tryParsePendingResp:  │                    │
   │                      │  split by newline →    │                    │
   │                      │  per-item results:     │                    │
   │                      │  value → { type:       │                    │
   │                      │   'provided', key,     │                    │
   │                      │   value }              │                    │
   │                      │  no value → { type:    │                    │
   │                      │   'collect_skipped' }  │                    │
   │                      │                        │                    │
   │                      │  resolvePending()      │                    │
   │                      │  response:             │                    │
   │                      │  { kind: 'sensitive_   │                    │
   │                      │    info_operation',    │                    │
   │                      │    requestId,          │                    │
   │                      │    results: [...] }    │                    │
   │  XacppResponse       │                        │                    │
   │←─────────────────────│                        │                    │
   │                      │                        │                    │
```

### 6.4 Pending Queue State Machine

```
                    ┌─────────────────────────────────────┐
                    │         Pending Queue               │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ Key: chatId:senderId        │   │
                    │  │                             │   │
                    │  │  active: PendingItem | null │   │
                    │  │  queue: PendingItem[]        │   │
                    │  └─────────────────────────────┘   │
                    └─────────────────┬───────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
            ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
            │   EMPTY        │  │   HAS ACTIVE   │  │   QUEUED      │
            │               │  │               │  │               │
            │  New item →   │  │  Reply →      │  │  Reply →      │
            │  become active│  │  resolve →    │  │  resolve →    │
            │               │  │  sendNext     │  │  sendNext     │
            └───────────────┘  └───────┬───────┘  └───────┬───────┘
                                       │                  │
                                       └────────┬─────────┘
                                                ▼
                                    ┌───────────────────┐
                                    │  Active resolved  │
                                    │  sendNextPending │
                                    │  → next active   │
                                    │  or empty        │
                                    └───────────────────┘
```

## 7. Typing Indicator Lifecycle

```
Downstream              Bridge              PlatformClient
  Agent                   │                        │
   │                      │                        │
   │  invoke_activity     │                        │
   │  (any content)       │                        │
   │←─────────────────────│                        │
   │                      │                        │
   │                      │  setTypingIndicator    │
   │                      │  (chatId, senderId,   │
   │                      │   messageId)          │
   │                      ├───────────────────────→│
   │                      │                        │
   │  [any event except   │                        │
   │   complete]          │                        │
   │←─────────────────────│                        │
   │                      │                        │
   │                      │  refreshTypingIndicator│
   │                      ├───────────────────────→│
   │                      │                        │
   │  Event: complete     │                        │
   │←─────────────────────│                        │
   │                      │                        │
   │                      │  releaseTypingIndicator│
   │                      ├───────────────────────→│
   │                      │                        │
```

## 8. Graceful Shutdown

```
OS Signal                  run()                    Bridge                Peer
(SIGINT/                    │                         │                    │
 SIGTERM)                   │                         │                    │
   │                        │                         │                    │
   ├───────────────────────→│                         │                    │
   │                        │                         │                    │
   │                        │  SIGINT/SIGTERM handler │                    │
   │                        │  bridge.close()          │                    │
   │                        ├────────────────────────→│                    │
   │                        │                         │                    │
   │                        │  abort message loop     │                    │
   │                        │  resolve pending with   │                    │
   │                        │    error                │                    │
   │                        │  release all typing     │                    │
   │                        │  indicators             │                    │
   │                        │                         │                    │
   │                        │  cloud.close()          │                    │
   │                        │  transport.close()      │                    │
   │                        │                         │                    │
   │                        │  peer.disconnect()      │                    │
   │                        ├─────────────────────────┼───────────────────→│
   │                        │                         │                    │
   │                        │  process.exit(0)        │                    │
   │                        │                         │                    │
```

## 9. Data Structure Maps

### 9.1 Activity Tracking

```
chatUserToActivity
─────────────────────────────────────────────────────────────────
│ chatId           │ Map<UserId, ActivityId>                    │
├──────────────────┼────────────────────────────────────────────┤
│ "group_123"     │  "user_1" → "act_abc"                      │
│                 │  "user_2" → "act_def"                      │
├──────────────────┼────────────────────────────────────────────┤
│ "dm_456"        │  "user_3" → "act_ghi"                       │
└──────────────────┴────────────────────────────────────────────┘

activityToTarget (reverse lookup)
─────────────────────────────────────────────────────────────────
│ ActivityId      │ { chatId, senderId }                       │
├──────────────────┼────────────────────────────────────────────┤
│ "act_abc"       │  { chatId: "group_123", senderId: "user_1" }│
│ "act_def"       │  { chatId: "group_123", senderId: "user_2" }│
│ "act_ghi"       │  { chatId: "dm_456", senderId: "user_3" }   │
└──────────────────┴────────────────────────────────────────────┘
```

### 9.2 Activity States

```
activityStates
─────────────────────────────────────────────────────────────────
│ ActivityId      │ State                                      │
├──────────────────┼────────────────────────────────────────────┤
│ "act_abc"       │  {                                        │
│                 │    processingMessageId: "msg_xyz",       │
│                 │    thinkingStart: 1700000000000,         │
│                 │    toolActiveStart: 1700000001000,       │
│                 │    expressingStart: 1700000002000         │
│                 │  }                                        │
└──────────────────┴────────────────────────────────────────────┘
```

## 10. Command Parsing

```
Message Content              Parsing Result
─────────────────────────────────────────────────────────────────
"/new Fix the bug"          → requestCommand({ new_activity, prompt: "Fix the bug" })
"/compact"                 → requestCommand({ compact_activity })
"/cancel"                  → requestCommand({ cancel_activity })
"/unknown"                  → unknown_command → send error to cloud
"Hello"                     → resolve/create activity → invoke_activity
"/new" (no args)            → requestCommand({ new_activity }) → invoke_activity
```

## 11. Reply Parsing for Pending Items

```
Pending Type        User Input              Parsed Result
─────────────────────────────────────────────────────────────────
action_request      "a"                   → { kind:'action', type:'approve_always' }
                    "y"                   → { kind:'action', type:'approve' }
                    "n"                   → { kind:'action', type:'reject', reason:'用户拒绝' }
                    "n reason"            → { kind:'action', type:'reject', reason:'reason' }
                    "c"                   → { kind:'action', type:'reject', reason:'用户取消执行' }
─────────────────────────────────────────────────────────────────
question            "1", "2", ...         → { kind:'question', type:'answer', content:options[N-1] }
                    "some text"           → { kind:'question', type:'answer', content:'some text' }
                    "c"                   → { kind:'question', type:'skip', reason:'用户取消执行' }
─────────────────────────────────────────────────────────────────
sensitive_info_     line1\line2\...       → collect: [{ type:'provided', key, value }, ...]
operation           (one line per item)     missing → { type:'collect_skipped', key, reason }
                    "c"                   → [{ type:'collect_skipped'|'delete_rejected', ... }]
─────────────────────────────────────────────────────────────────
```

# xabot — TypeScript Core Design Document

> Status: Migrated to XACPP
> Created: 2026-04-23 15:09
> Predecessor: ~/projects/xabot-rs (Rust version)

---

## 1. Overview

xabot is the bridge between downstream Agents and cloud IM. Connects to Agents via XACPP protocol and to cloud platforms (Feishu/WeChat/Discord etc.) via platform SDKs, enabling bidirectional message routing.

```
Cloud IM ←→ xabot ←→ Downstream Agent (XACPP)
```

## 2. Core Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `xacpp` | ^1.2.1 | XACPP protocol implementation, connects downstream Agent |
| `@larksuite/node-sdk` | latest | Feishu official SDK, WebSocket long connection + REST API |

## 3. Project Structure

```
xabot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public entry point
│   ├── i18n/
│   │   └── index.ts          # i18n message translation (x-agent i18n:// keys)
│   ├── core/
│   │   ├── types.ts          # Standard message types (Message, ChannelId, UserId)
│   │   ├── client.ts         # Platform Client interface
│   │   ├── error.ts          # Structured error types
│   │   ├── logger.ts         # stderr-only logger (stdout is the frame pipe)
│   │   ├── fs-utils.ts       # Temp file helpers (saveTemp / safeUnlink)
│   │   └── pairing.ts        # Pairing code flow
│   ├── xacpp/
│   │   ├── capabilities.ts   # Shared Responder capabilities declaration
│   │   ├── establish-handler.ts      # XACPP EstablishHandler implementation
│   │   ├── session-handler.ts        # XACPP SessionHandler (Responder side)
│   │   ├── initiator-session-handler.ts # XACPP SessionHandler (Initiator side, chat subcommand)
│   │   └── stdin-router.ts   # stdin line router for interactive chat commands
│   ├── platforms/
│   │   ├── feishu/
│   │   │   ├── client.ts     # Feishu Client implementation
│   │   │   ├── message.ts    # Feishu message ↔ standard message conversion
│   │   │   └── upload.ts     # Media upload (image/file)
│   │   └── wechat/
│   │       ├── client.ts     # WeChat Client implementation
│   │       ├── crypto.ts     # WeChat crypto helpers
│   │       ├── login.ts      # QR-code login flow
│   │       ├── message.ts    # WeChat message ↔ standard message conversion
│   │       └── upload.ts     # Media upload
│   ├── bridge/
│   │   ├── index.ts          # Bridge: cloud ↔ XACPP message routing
│   │   └── input-parser.ts   # chat-mode stdin command parsing (/new /compact /cancel)
│   └── cli/
│       ├── index.ts          # CLI entry point (commander)
│       ├── feishu.ts         # feishu subcommand (platform credentials)
│       ├── wechat.ts         # wechat subcommand (platform credentials)
│       ├── health.ts         # health subcommand
│       ├── run.ts            # run subcommand (Bridge mode)
│       └── chat.ts           # chat subcommand (Initiator + Responder in-process)
```

**Key: xabot does not persist any configuration.** All config (credentials) are passed via CLI arguments when the downstream Agent starts. The chatId is obtained dynamically via the Establish handshake.

## 4. Core Interface Design

### 4.1 Platform Client Interface

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

### 4.3 XACPP Protocol Layer

```
Transport  Frame layer: binary frame encode/decode + request-response ID correlation
  └─ Peer   Protocol endpoint: state machine + establish/session routing
       └─ Session  Logical session: created after establish, holds transport reference
            └─ Activity  Activity context: one-to-one mapped with chatId
                 └─ Event  In-activity event: routed via activity field
```

- xabot is the XACPP Responder (passively accepts establish and events)
- Downstream Agent is the Initiator (actively initiates establish)
- Challenge flow: Initiator generates challenge → user sends to bot via Feishu → Responder matches in cloud.messages() → chatId becomes credentials

## 5. Communication Modes

| Platform | Mode | Port Requirements |
|----------|------|------------------|
| Feishu | WebSocket long connection (built-in SDK) | None |
| WeChat | HTTP long-polling | None |

Both Feishu and WeChat require no open ports.

## 6. Full Sequence

### Startup

```
Downstream Agent call: xabot run --platform feishu --app-id X --app-secret Y
├─ All config passed via CLI arguments, xabot does not persist any config
├─ Platform Client.connect() (Feishu WebSocket / WeChat long-polling)
├─ Bridge.run() Phase 1: scan cloud messages for challenge (UUID format text)
├─ XacppPeer.connect() (stdin/stdout binary frames)
│   └─ Establish handshake: Initiator sends challenge → user sends to bot →
│      Responder matches via cloud.messages() → obtain chatId as credentials
├─ Bridge.markEstablished() → switch to Phase 2
└─ Bridge.run() Phase 2: activity routing (cloud ↔ XACPP)
```

### Message Loop

```
Cloud message → chatId → find activityId
├─ Not exists → session.requestCommand({ new_activity }) → create mapping
└─ session.requestCommand({ invoke_activity }) → forward to Agent

Agent event → activity → find chatId
├─ content_delta/complete → cloud.send()
├─ notify → cloud.send()
├─ action_request → cloud.send() → block waiting for cloud response → return
└─ info/warn/error → log output
```

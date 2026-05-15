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
| `xacpp` | ^0.3.1 | XACPP protocol implementation, connects downstream Agent |
| `@larksuite/node-sdk` | latest | Feishu official SDK, WebSocket long connection + REST API |
| `zod` | latest | CLI argument validation |

## 3. Project Structure

```
xabot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public entry point
│   ├── config/
│   │   └── schema.ts         # CLI argument schema (zod validation, no persistence)
│   ├── core/
│   │   ├── types.ts          # Standard message types (Message, ChannelId, UserId)
│   │   ├── client.ts         # Platform Client interface
│   │   ├── error.ts          # Structured error types
│   │   └── pairing.ts        # Pairing code flow
│   ├── xacpp/
│   │   ├── establish-handler.ts  # XACPP EstablishHandler implementation
│   │   └── session-handler.ts    # XACPP SessionHandler implementation
│   ├── platforms/
│   │   ├── feishu/
│   │   │   ├── client.ts     # Feishu Client implementation
│   │   │   └── message.ts    # Feishu message ↔ standard message conversion
│   │   └── wechat/
│   │       ├── client.ts     # WeChat Client implementation
│   │       └── message.ts    # WeChat message ↔ standard message conversion
│   ├── bridge/
│   │   └── index.ts          # Bridge: cloud ↔ XACPP message routing
│   └── cli/
│       ├── index.ts          # CLI entry point (commander)
│       ├── discover.ts       # discover subcommand
│       ├── listen.ts         # listen subcommand
│       ├── send.ts           # send subcommand
│       ├── health.ts         # health subcommand
│       └── run.ts            # run subcommand (Bridge mode)
```

**Key: xabot does not persist any configuration.** All config (credentials, chat_ids) are passed via CLI arguments when the downstream Agent starts.

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
Transport  Frame layer: JSONL envelope encode/decode + request-response ID correlation
  └─ Peer   Protocol endpoint: state machine + establish/session routing
       └─ Session  Logical session: created after establish, holds transport reference
            └─ Activity  Activity context: one-to-one mapped with chatId
                 └─ Event  In-activity event: routed via activity field
```

- xabot is the XACPP Responder (passively accepts establish and events)
- Downstream Agent is the Initiator (actively initiates establish)

## 5. Communication Modes

| Platform | Mode | Port Requirements |
|----------|------|------------------|
| Feishu | WebSocket long connection (built-in SDK) | None |
| WeChat | HTTP long-polling | None |

Both Feishu and WeChat require no open ports.

## 6. Full Sequence

### Startup

```
Downstream Agent call: xabot run --platform feishu --app-id X --app-secret Y --chat-ids a,b,c
├─ All config passed via CLI arguments, xabot does not persist any config
├─ Platform Client.connect() (Feishu WebSocket / WeChat long-polling)
├─ XacppPeer.connect() (stdin/stdout JSONL)
├─ Wait for downstream Agent establish → obtain Session → inject Bridge
└─ Bridge.run() → cloud message loop
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

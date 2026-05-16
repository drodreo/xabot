**[中文文档](README.zh-CN.md)**

# xabot

Bidirectional message bridge connecting XACPP-enabled Agents to Feishu and WeChat.

```
Cloud IM (Feishu / WeChat) ←→ xabot ←→ Agent (XACPP)
```

xabot is the **XACPP Responder** — it passively accepts establish requests from downstream XACPP Initiators and routes messages to/from cloud IM platforms. xabot only works with [XACPP-compatible](#xacpp-protocol) peers.

## Install

```bash
npm install -g xabot
```

Or build from source:

```bash
git clone https://github.com/drodreo/xabot.git
cd xabot
npm install
npm run build
npm install -g .
```

## Usage

CLI is organized by platform subcommands:

```
xabot feishu --app-id <ID> --app-secret <SECRET> <action>
xabot wechat login
xabot wechat --token <TOKEN> <action>
```

### Actions

| Action | Lifecycle | Description |
|--------|-----------|-------------|
| `login` | One-shot | WeChat only — QR code scan login, outputs `{ token, baseUrl }` |
| `health` | One-shot | Verify credentials and connectivity |
| `run` | Long-running | Production: stdio ↔ platform bidirectional bridge |
| `chat` | Long-running | Interactive debug: terminal ↔ Agent ↔ platform |

### Feishu

```bash
# Health check
xabot feishu --app-id <ID> --app-secret <SECRET> health

# Production bridge
xabot feishu --app-id <ID> --app-secret <SECRET> run

# Interactive chat
xabot feishu --app-id <ID> --app-secret <SECRET> chat
```

### WeChat

WeChat uses a two-stage connection — login first to obtain a token, then use it:

```bash
# Stage 1: QR code login → stdout prints { token, baseUrl }
xabot wechat login

# Stage 2: Use the token
xabot wechat --token <TOKEN> health
xabot wechat --token <TOKEN> run
xabot wechat --token <TOKEN> chat
```

### chat Terminal Commands

In `chat` mode, text input is parsed into commands or plain messages:

| Input | Action |
|-------|--------|
| Plain text | Send to Agent as `invoke_activity` |
| `/new [prompt]` | Create a new Activity |
| `/compact` | Compress current Activity context |
| `/cancel` | Cancel current Activity |

## Development

```bash
npm install
npm run build    # Compile TypeScript → dist/
npm test         # Run all tests (vitest)
```

## Architecture

```
xabot/
├── src/
│   ├── core/            # Platform client interface, types, pairing
│   ├── xacpp/           # XACPP EstablishHandler & SessionHandler
│   ├── platforms/
│   │   ├── feishu/      # Feishu client (WebSocket)
│   │   └── wechat/      # WeChat client (HTTP long-polling)
│   ├── bridge/          # Bidirectional message routing: cloud ↔ XACPP
│   └── cli/             # CLI entry point & subcommands (commander)
```

Key design points:
- **No persistence** — credentials are passed via CLI arguments
- **chatId via Establish handshake** — obtained dynamically, no hardcoded IDs
- **Activity ↔ chatId** — each chatId maps to exactly one XACPP activity

## XACPP Protocol

xabot implements the Responder side of the XACPP (eXtensible Agent Control Plane Protocol). The downstream Agent connects as the Initiator.

Protocol SDKs:

| SDK | Language | Repository |
|-----|----------|------------|
| xacpp-ts | TypeScript | https://github.com/drodreo/xacpp-ts |
| xacpp-rs | Rust | https://github.com/drodreo/xacpp-rs |

## License

MIT

**[中文文档](README.zh-CN.md)**

# xabot

A bridge between downstream Agents and cloud IM platforms. Connects to Agents via the [XACPP](https://github.com/drodreo/xacpp-ts) protocol and to cloud platforms (Feishu / WeChat) via platform SDKs, enabling bidirectional message routing.

```
Cloud IM ←→ xabot ←→ Downstream Agent (XACPP)
```

**xabot is the XACPP Responder** — it passively accepts establish requests and events from downstream Agents (Initiators).

## Tech Stack

- TypeScript, ESM mode
- Build: `tsc` → `dist/`
- Test: `vitest`
- Runtime deps: `@larksuiteoapi/node-sdk`, `xacpp`, `commander`, `zod`

## Install

```bash
npm run build                          # tsc compile + npm pack → xabot-1.0.0.tgz
npm install -g ./xabot-1.0.0.tgz       # Install globally
```

After installation, `xabot <subcommand>` works from any directory.

Uninstall: `npm uninstall -g xabot`

## CLI Subcommands

| Subcommand | Lifecycle | Purpose |
|------------|-----------|---------|
| `health` | One-shot | Credential/connectivity check |
| `discover` | One-shot (with timeout) | Get chatId via pairing code |
| `send` | One-shot | Send message to a known chatId |
| `listen` | Long-running | Interactive debug: stdin send + receive platform messages |
| `run` | Long-running | Production: cloud ↔ XACPP bidirectional bridge |

### Quick Examples

```bash
# Health check
xabot health --platform feishu --app-id X --app-secret Y

# Discover chatId via pairing code
xabot discover --platform feishu --app-id X --app-secret Y

# Send a message
xabot send --platform feishu --app-id X --app-secret Y <CHAT_ID> "Hello"

# Interactive listen
xabot listen --platform feishu --app-id X --app-secret Y --chat-id <CHAT_ID>

# Production bridge mode
xabot run --platform feishu --app-id X --app-secret Y --chat-ids a,b,c
```

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
- **No persistence** — all configuration (credentials, chat_ids) is passed via CLI arguments
- **Activity ↔ chatId mapping** — each chatId maps to exactly one XACPP activity
- **Three-step handshake** — `credentials === null` → `challenge_required` → initiator confirm → session; otherwise directly established

## License

MIT

---
name: xabot-cli
description: |
  xabot CLI usage guide. Triggers when connecting to Feishu or WeChat for message
  bridging, interactive chat debugging, or production run mode.
  Keywords: xabot, feishu, wechat, iLink Bot, XACPP, bridge, chat
---

# xabot CLI Usage Guide

## Overview

xabot is a message bridge between **XACPP protocol peers** (downstream Agents) and cloud IM platforms (Feishu/WeChat). It is **only compatible with XACPP-compatible endpoints** — the downstream process connected via stdio (run mode) or the co-located Initiator peer (chat mode) must implement the XACPP protocol.

```
Terminal / Agent ←→ XACPP ←→ xabot (Bridge) ←→ Platform SDK ←→ Feishu / WeChat
```

CLI is organized by platform subcommands:

```
xabot feishu --app-id X --app-secret Y <action>
xabot wechat --token T [--base-url U] <action>
```

For the XACPP protocol specification, see the appendix at the bottom.

## Prerequisites

### Build

```bash
npm run build      # tsc compile + npm pack → xabot-1.0.0.tgz
```

### Global Install (optional)

```bash
npm install -g ./xabot-1.0.0.tgz
xabot --help
```

Without global install, use `npx xabot` or `node dist/cli/index.js`.

---

## Feishu (Lark)

### Credentials

Obtain from the [Feishu Open Platform](https://open.feishu.cn) after creating an application:

- `--app-id`: Application ID
- `--app-secret`: Application Secret

These are **pre-known** — no separate login step is required.

### One-step Connection

Feishu does not require a multi-stage connection. With known credentials, launch directly:

```bash
# Verify credentials
xabot feishu --app-id <ID> --app-secret <SECRET> health

# Production: stdio ↔ Agent bidirectional bridge
xabot feishu --app-id <ID> --app-secret <SECRET> run

# Interactive debug: terminal ↔ Agent ↔ Feishu
xabot feishu --app-id <ID> --app-secret <SECRET> chat
```

### chat Handshake

When running `chat` without `--credentials` for the first time:

1. xabot starts an internal TCP loopback (Initiator + Responder)
2. A **Pairing Code** (UUID) is printed to stderr
3. The user sends this code to the bot via Feishu
4. Bridge scans incoming messages for a match and completes the handshake
5. On success, stderr prints `Connected! chatId: xxx`

After a successful handshake, the `chatId` can be reused with `--credentials <chatId>` to skip pairing on subsequent runs.

---

## WeChat (iLink Bot)

### Two-stage Connection

Unlike Feishu, WeChat credentials (`bot_token`) are obtained through a **QR code scan login**. The process is explicitly two stages:

```
Stage 1: login → scan QR code → obtain token + baseUrl
Stage 2: use token with health / run / chat
```

### Stage 1: QR Code Login

```bash
xabot wechat login
```

Interaction flow:

```
请使用微信扫描二维码登录
按回车键在浏览器中打开二维码...
                    ← user presses Enter
[browser opens QR code image]
等待扫码中...
已扫码，请在手机上确认...
登录成功！
{"token":"ilinkbot_xxx","baseUrl":"https://ilinkai.weixin.qq.com"}
```

**Key: stdout outputs machine-readable JSON; stderr outputs human-readable prompts.**

#### Handling login output

On success, stdout prints a single line of JSON:

```json
{"token":"ilinkbot_4Q7iH3oVt9YF0dJ2sK1mLp6r","baseUrl":"https://ilinkai.weixin.qq.com"}
```

- `token` — the `--token` value for all subsequent action subcommands
- `baseUrl` — the API base URL. Usually the default, but WeChat may return a non-default value. **Always save this and pass it to `--base-url` in subsequent commands** to avoid rework if WeChat enables dynamic URLs in the future

#### Scripted usage

```bash
# Save login result
RESULT=$(xabot wechat login)
TOKEN=$(echo "$RESULT" | jq -r '.token')
BASE_URL=$(echo "$RESULT" | jq -r '.baseUrl')

# Launch chat with saved credentials
xabot wechat chat --token "$TOKEN" --base-url "$BASE_URL"
```

#### Manual usage

```bash
# 1. Login — note the JSON output
xabot wechat login

# 2. Copy token and baseUrl, then launch chat
xabot wechat chat --token ilinkbot_xxx --base-url https://ilinkai.weixin.qq.com
```

#### Important notes

- There is no token refresh endpoint. On expiry (errcode=-14), re-run `login`
- Ctrl+C interrupts the login flow
- QR codes expire; if expired, re-run `login`

### Stage 2: Using the Token

```bash
# Verify token
xabot wechat health --token <TOKEN> --base-url <BASE_URL>

# Production: stdio ↔ Agent bidirectional bridge
xabot wechat run --token <TOKEN> --base-url <BASE_URL>

# Interactive debug: terminal ↔ Agent ↔ WeChat
xabot wechat chat --token <TOKEN> --base-url <BASE_URL>
```

`--base-url` is optional and defaults to `https://ilinkai.weixin.qq.com`. If `login` returned a non-default value, **it must be provided**.

### chat Handshake

Same as Feishu — without `--credentials`, a Pairing Code is generated and must be sent to the bot via WeChat.

**WeChat-specific constraint**: Outbound messages require a `context_token` obtained from inbound messages. The bot must receive at least one message from the user before it can reply. Proactive messaging without a prior inbound message is not possible.

---

## Subcommand Reference

| Subcommand | Platform | Lifecycle | Description |
|------------|----------|-----------|-------------|
| `login` | wechat | One-shot | QR code scan login; outputs `{ token, baseUrl }` to stdout |
| `health` | Both | One-shot | Verify credentials and connectivity |
| `run` | Both | Long-running | Production mode: stdio ↔ platform bidirectional bridge |
| `chat` | Both | Long-running | Interactive: terminal ↔ Agent ↔ platform |

### chat Terminal Commands

In chat mode, text input is parsed into commands or plain messages:

| Input | Action |
|-------|--------|
| Plain text | Sent to Agent as `invoke_activity` |
| `/new [prompt]` | Create a new Activity (optional initial prompt) |
| `/compact` | Compress current Activity context |
| `/cancel` | Cancel current Activity |
| `/xxx` | Unknown command; prints supported commands |

---

## Data Flow (chat mode)

```
Terminal stdin ←→ StdinRouter ←→ InitiatorSessionHandler
                                      ↕ TCP 127.0.0.1:random
                              Responder (Bridge)
                                      ↕
                              PlatformClient (Feishu/WeChat)
```

- **Initiator side**: Terminal input → `sendReply()` → XACPP command → Bridge → `cloud.send()` → Platform
- **Responder side**: Platform message → `cloud.messages()` → Bridge `parseInput` dispatch → XACPP command → Initiator → stderr output

---

## Troubleshooting

### WeChat poll errors after chat start

- `ret=undefined`: Expected — WeChat API omits `ret` on success. This has been fixed.
- `errcode=-14`: Token expired. Re-run `xabot wechat login`.
- HTTP 401: Invalid token. Verify it was copied completely.

### Feishu chat handshake hangs

- Confirm the bot application has "receive message" event subscription enabled
- Verify Feishu WebSocket connectivity with `health`
- Send the Pairing Code as plain text (no prefix or formatting)

### WeChat cannot proactively send messages

WeChat requires `context_token` (obtained from inbound messages) for outbound messages. Ensure the user has sent at least one message to the bot.

---

## Appendix: XACPP Protocol

xabot is the **Responder** side of the XACPP (eXtensible Agent Control Plane Protocol). The downstream Agent connects as the **Initiator**. xabot only works with XACPP-compatible peers.

Protocol implementations:

| SDK | Language | Repository |
|-----|----------|------------|
| xacpp-ts | TypeScript | https://github.com/drodreo/xacpp-ts |
| xacpp-rs | Rust | https://github.com/drodreo/xacpp-rs |

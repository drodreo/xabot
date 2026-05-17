---
name: xabot-cli
description: |
  SOP for establishing communication with Feishu or WeChat via xabot CLI.
  Keywords: xabot, feishu, wechat, iLink Bot, bridge, chat
---

# xabot Communication SOP

xabot bridges XACPP protocol peers to Feishu / WeChat. Follow the steps below to establish communication.

**Prerequisite**: xabot is globally installed (`npm install -g xabot`). All commands use `xabot` directly.

---

## Feishu

### Prerequisites

Obtain from the user:
- Feishu App ID
- Feishu App Secret

### Steps

1. **Verify connectivity**

   ```bash
   xabot feishu --app-id <ID> --app-secret <SECRET> health
   ```

   Success: exit code 0. Failure: stderr prints error details.

2. **Start bridge**

   ```bash
   xabot feishu --app-id <ID> --app-secret <SECRET> run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.

---

## WeChat

### Steps

1. **Login (obtain token)**

   ```bash
   xabot wechat login
   ```

   **Interactive** — requires the user to:
   - Press Enter to open a browser showing a QR code
   - Scan the QR code with WeChat and confirm on phone

   On success, **stdout** prints a single JSON line:

   ```json
   {"token":"ilinkbot_xxx","baseUrl":"https://ilinkai.weixin.qq.com"}
   ```

   Save both values. `token` is required for all subsequent commands. Pass `baseUrl` as `--base-url` if it differs from the default.

   On failure or expiry, re-run `login`.

2. **Verify connectivity**

   ```bash
   xabot wechat --token <TOKEN> --base-url <URL> health
   ```

3. **Start bridge**

   ```bash
   xabot wechat --token <TOKEN> --base-url <URL> run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.

---

## Error Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `errcode=-14` | WeChat token expired | Re-run `xabot wechat login` |
| HTTP 401 | Invalid token | Verify token was copied completely |
| Bot cannot reply (WeChat) | No inbound message yet | Wait for user to send a message first |

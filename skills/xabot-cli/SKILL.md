---
name: xabot-cli
description: |
  SOP for establishing communication with Feishu or WeChat via xabot CLI.
  Keywords: xabot, feishu, wechat, iLink Bot, bridge, chat
---

# xabot Communication SOP

xabot bridges XACPP protocol peers to Feishu / WeChat. Follow the steps below to establish communication.

**Invocation**: `npx xabot` (auto-downloads if not installed) or `xabot` (if globally installed).

### Choose Platform

If the user does not specify a platform, ask which one to connect to before proceeding.

### Credential Storage

Platform credentials are stored via the `sensitive_info` tool as environment variables. Never ask for secrets directly in conversation.

| Credential | Environment Variable | Source |
|------------|---------------------|--------|
| Feishu App ID | `XABOT_FEISHU_APP_ID` | User provides |
| Feishu App Secret | `XABOT_FEISHU_APP_SECRET` | User provides |

---

## Feishu

### Prerequisites

Collect via `sensitive_info`:
- `XABOT_FEISHU_APP_ID`
- `XABOT_FEISHU_APP_SECRET`

### Steps

1. **Verify connectivity**

   ```bash
   xabot feishu --app-id $XABOT_FEISHU_APP_ID --app-secret $XABOT_FEISHU_APP_SECRET health
   ```

   Success: exit code 0. Failure: stderr prints error details.

2. **Start bridge**

   ```bash
   xabot feishu --app-id $XABOT_FEISHU_APP_ID --app-secret $XABOT_FEISHU_APP_SECRET run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.

---

## WeChat

### Steps

1. **Verify connectivity** (requires a previously obtained token)

   ```bash
   xabot wechat --token <TOKEN> health
   ```

2. **Start bridge**

   ```bash
   xabot wechat run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.
   
   On first start, the process automatically opens a browser for QR-code login. After the user scans and confirms on their phone, the bridge begins normal operation. If the token expires (`errcode=-14`), the bridge automatically re-triggers the login flow.

3. **Interactive chat**

   ```bash
   xabot wechat chat
   ```

   Same auto-login behavior as `run`.

---

## Error Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `errcode=-14` | WeChat token expired | Bridge auto-relogs; no manual action needed |
| HTTP 401 | Invalid token | Verify the `--token` passed to `health` |
| Bot cannot reply (WeChat) | No inbound message yet | Wait for user to send a message first |

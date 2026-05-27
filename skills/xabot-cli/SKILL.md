---
name: xabot-cli
description: |
  SOP for establishing communication with Feishu or WeChat via xabot CLI.
  Keywords: xabot, feishu, wechat, iLink Bot, bridge, run
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

Before configuring Feishu connectivity, the user must complete the Feishu app setup. Follow these steps in order:

1. **Guide the user through Feishu app setup**: Follow the instructions in [references/feishu-setup.md](references/feishu-setup.md). This includes creating a Feishu app, configuring bot capabilities, setting permissions (use [references/feishu-permissions.json](references/feishu-permissions.json) for the permission list), and obtaining the App ID and App Secret.

2. **Wait for user confirmation**: After presenting the setup guide, tell the user to complete all preparation work and come back when ready. **Do not proceed** until the user explicitly says they have finished the preparation.

3. **Collect credentials**: Once the user confirms readiness, collect via `sensitive_info`:
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

1. **Start bridge**

   ```bash
   xabot wechat run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.

   On first start, the process automatically opens a browser for QR-code login. After the user scans and confirms on their phone, the bridge begins normal operation. If the token expires (`errcode=-14`), the bridge automatically re-triggers the login flow.

   **Note**: `health` command requires a valid token obtained from a previous successful `run` (i.e. at least one completed pairing). Do not run `health` before the first `run`.

---

## Verbose Mode

Both `run` subcommands accept `--verbose` to send intermediate agent state indicators to the IM chat:

```bash
xabot wechat run --verbose
xabot feishu --app-id $XABOT_FEISHU_APP_ID --app-secret $XABOT_FEISHU_APP_SECRET run --verbose
```

When verbose is enabled, the following indicators are sent to the IM:
- `💭 正在思考...` when the agent enters the thinking phase
- `🔧 行动中...` when the agent invokes a tool
- Content parts are forwarded in real-time as they arrive

When verbose is disabled (default), only the final response is sent after the agent completes.

**Do not enable verbose by default.** It makes the IM conversation noisy. Only use `--verbose` when the user explicitly requests it.

---

## Connection Management via aconnman

xabot instances are managed as XACPP external connections through the `aconnman` tool.

### Restarting Connections After Updates

After upgrading xabot, all running connections must be restarted to load the new version.

**⚠️ Correct restart procedure:**

1. **List connections first** to obtain the connection IDs:

   ```
   aconnman → operation: list
   ```

2. **Restart each connection by ID** (not by name — aconnman requires the UUID):

   ```
   aconnman → operation: restart, id: <connection-id-from-list>
   ```

**Common mistake**: Calling `aconnman restart` with a name like "xabot" instead of the UUID. This will fail with "record not found". Always list first, then restart by ID.

---

## Installation & Upgrade

### Step 1: Check local assets

优先使用技能包 [assets/](assets/) 目录下自带的本地安装包：

```bash
ls assets/xabot-*.tgz
```

如果存在，使用本地包安装（替换为实际文件名）：

```bash
npm install -g assets/xabot-<version>.tgz
```

### Step 2: Fallback to npm

仅当 `assets/` 目录下没有 tgz 文件时，从 npm 安装：

```bash
npm install -g xabot
```

### After installation

1. **Verify**: `xabot --version`
2. **Restart all connections** via aconnman (see Connection Management section above)

---

## Error Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `errcode=-14` | WeChat token expired | Bridge auto-relogs; no manual action needed |
| HTTP 401 | Invalid token | Verify the `--token` passed to `health` |
| Bot cannot reply (WeChat) | No inbound message yet | Wait for user to send a message first |
| aconnman restart fails with "record not found" | Used connection name instead of UUID | List connections first, then restart by ID |
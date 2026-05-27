---
name: xabot-cli
description: |
  SOP for establishing communication with Feishu or WeChat via xabot-cli CLI.
  Keywords: xabot-cli, feishu, wechat, iLink Bot, bridge, run
---

# xabot-cli Communication SOP

xabot-cli bridges XACPP protocol peers to Feishu / WeChat. Follow the steps below to establish communication.

**Invocation**: `npx xabot-cli` (auto-downloads if not installed) or `xabot-cli` (if globally installed).

### Choose Platform

If the user does not specify a platform, ask which one to connect to before proceeding.

### Credential Storage

Platform credentials are stored via the `sensitive_info` tool as environment variables. Never ask for secrets directly in conversation.

**Naming rule**: `XABOT_FEISHU_APP_ID` / `XABOT_FEISHU_APP_SECRET` as base names. When multiple Feishu connections exist, append a numeric suffix: `XABOT_FEISHU_APP_ID_1`, `XABOT_FEISHU_APP_ID_2`, etc.

**Before creating a new connection**, query existing sensitive info entries to determine the next available suffix:

1. `sensitive_info` → `action: list, siType: env_var` → count entries whose key starts with `XABOT_FEISHU_APP_ID`
2. If count = 0 → use base name: `XABOT_FEISHU_APP_ID`, `XABOT_FEISHU_APP_SECRET`
3. If count = N (N ≥ 1) → use suffix `_N`: `XABOT_FEISHU_APP_ID_N`, `XABOT_FEISHU_APP_SECRET_N`

| Existing Count | New Connection Credentials |
|---------------|---------------------------|
| 0 | `XABOT_FEISHU_APP_ID`, `XABOT_FEISHU_APP_SECRET` |
| 1 | `XABOT_FEISHU_APP_ID_1`, `XABOT_FEISHU_APP_SECRET_1` |
| 2 | `XABOT_FEISHU_APP_ID_2`, `XABOT_FEISHU_APP_SECRET_2` |

---

## Feishu

### Prerequisites

Before configuring Feishu connectivity, the user must complete the Feishu app setup. Follow these steps in order:

1. **Guide the user through Feishu app setup**: Follow the instructions in [references/feishu-setup.md](references/feishu-setup.md). This includes creating a Feishu app, configuring bot capabilities, setting permissions (use [references/feishu-permissions.json](references/feishu-permissions.json) for the permission list), and obtaining the App ID and App Secret.

2. **Wait for user confirmation**: After presenting the setup guide, tell the user to complete all preparation work and come back when ready. **Do not proceed** until the user explicitly says they have finished the preparation.

3. **Collect credentials**: Once the user confirms readiness, query existing entries and determine the next suffix, then collect via `sensitive_info`.

### Steps

1. **Verify connectivity**

   POSIX (macOS / Linux):

   ```bash
   xabot-cli feishu --app-id "${XABOT_FEISHU_APP_ID}" --app-secret "${XABOT_FEISHU_APP_SECRET}" health
   ```

   Windows (cmd):

   ```cmd
   xabot-cli feishu --app-id %XABOT_FEISHU_APP_ID% --app-secret %XABOT_FEISHU_APP_SECRET% health
   ```

   Success: exit code 0. Failure: stderr prints error details.

2. **Start bridge**

   POSIX (macOS / Linux):

   ```bash
   xabot-cli feishu --app-id "${XABOT_FEISHU_APP_ID}" --app-secret "${XABOT_FEISHU_APP_SECRET}" run
   ```

   Windows (cmd):

   ```cmd
   xabot-cli feishu --app-id %XABOT_FEISHU_APP_ID% --app-secret %XABOT_FEISHU_APP_SECRET% run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.

   Accepts `--verbose` to send intermediate agent state indicators to the IM:
   - `💭 正在思考...` when the agent enters the thinking phase
   - `🔧 行动中...` when the agent invokes a tool
   - Content parts are forwarded in real-time as they arrive

   **Do not enable verbose by default.** Only use `--verbose` when the user explicitly requests it.

---

## WeChat

### Steps

1. **Start bridge**

   ```bash
   xabot-cli wechat run
   ```

   Long-running process. Stdio is used for XACPP bidirectional message routing.

   Accepts `--verbose` (same indicators as Feishu). Do not enable by default.

   On first start, the process automatically opens a browser for QR-code login. After the user scans and confirms on their phone, the bridge begins normal operation. If the token expires (`errcode=-14`), the bridge automatically re-triggers the login flow.

   **Note**: `health` command requires a valid token obtained from a previous successful `run` (i.e. at least one completed pairing). Do not run `health` before the first `run`.

---

## Connection Management via aconnman

xabot-cli instances are managed as XACPP external connections through the `aconnman` tool.

### Environment Variable Placeholder in aconnman args

When configuring `connectionSpec.args` for Feishu connections, credentials must reference environment variables stored via the `sensitive_info` tool.

**Placeholder format depends on the current platform** (aconnman config is per-instance, each instance runs on one OS only):

- **macOS / Linux**: `${VAR_NAME}` (POSIX shell expands)
- **Windows**: `%VAR_NAME%` (cmd.exe expands)

macOS / Linux:

```json
["feishu", "--app-id", "${XABOT_FEISHU_APP_ID}", "--app-secret", "${XABOT_FEISHU_APP_SECRET}", "run"]
```

Windows:

```json
["feishu", "--app-id", "%XABOT_FEISHU_APP_ID%", "--app-secret", "%XABOT_FEISHU_APP_SECRET%", "run"]
```

### Restarting Connections After Updates

After upgrading xabot-cli, all running connections must be restarted to load the new version.

**⚠️ Correct restart procedure:**

1. **List connections first** to obtain the connection IDs:

   ```
   aconnman → operation: list
   ```

2. **Restart each connection by ID** (not by name — aconnman requires the UUID):

   ```
   aconnman → operation: restart, id: <connection-id-from-list>
   ```

**Common mistake**: Calling `aconnman restart` with a name like "xabot-cli" instead of the UUID. This will fail with "record not found". Always list first, then restart by ID.

---

## Installation & Upgrade

### Step 1: Check local assets

Prefer the local tarball from the skill's [assets/](assets/) directory:

```bash
ls assets/xabot-cli-*.tgz
```

If found, install from the local package (replace with actual filename):

```bash
npm install -g assets/xabot-cli-<version>.tgz
```

### Step 2: Fallback to npm

Only when no tgz file exists in `assets/`, install from npm:

```bash
npm install -g xabot-cli
```

### After installation

1. **Verify**: `xabot-cli --version`
2. **Restart all connections** via aconnman (see Connection Management section above)

---

## Error Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `errcode=-14` | WeChat token expired | Bridge auto-relogs; no manual action needed |
| HTTP 401 | Invalid token | Verify the `--token` passed to `health` |
| Bot cannot reply (WeChat) | No inbound message yet | Wait for user to send a message first |
| aconnman restart fails with "record not found" | Used connection name instead of UUID | List connections first, then restart by ID |
| Windows: `xacpp stdio establish failed: connection closed` | aconnman args used `${VAR}` instead of `%VAR%` — cmd.exe does not expand `${}` | Reconfigure aconnman args using `%VAR_NAME%` format (Windows). Verify environment variable key exists in sensitive_info. |

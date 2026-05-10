# xabot 集成验收方案

## 前置条件

- 已有飞书/微信应用的 App ID 和 App Secret
- 已安装依赖：`npm install`
- 已构建：`npm run build`
- 使用真实凭据替换下文中的 `<APP_ID>`、`<APP_SECRET>`、`<CHAT_ID>`

## 验收流程（按顺序执行）

### 1. 健康检查 — 验证凭据与连接

**命令：**
```bash
npx xabot health --platform feishu --app-id <APP_ID> --app-secret <APP_SECRET>
```

**预期结果：**
```
✅ feishu 连接正常
```

**不通过的表现：**
```
❌ 健康检查失败: <错误原因>
```
说明凭据无效或服务不可达。

---

### 2. 发现 chatId — 配对码流程

**终端 A 执行：**
```bash
npx xabot discover --platform feishu --app-id <APP_ID> --app-secret <APP_SECRET>
```

**终端 A 预期输出：**
```
请在 60 秒内给 bot 发送以下配对码：A3F8K2
```

**此时在飞书中向机器人发送该配对码（纯文本 `A3F8K2`）。**

**终端 A 收到后输出：**
```
配对成功，chatId：oc_xxxxxxxxxxxxx
```

**不通过的表现：**
- 60 秒超时 → `❌ Timed out after 60000ms`
- 说明 bot 没收到消息，检查凭据和 WebSocket/长轮询连通性。

---

### 3. 监听消息 — 验证消息接收

**终端 A 执行：**
```bash
npx xabot listen --platform feishu --app-id <APP_ID> --app-secret <APP_SECRET>
```

**预期：** 终端进入监听状态，等待消息到来。

**此时在飞书中向机器人发送任意消息（如 "测试消息"），终端应输出：**
```
⬇ [oc_xxxxxxxxxxxxx] 测试消息
⬇ [oc_xxxxxxxxxxxxx] 你好
```
每收到一条消息，终端打印一行。

`Ctrl+C` 退出。

**不通过的表现：**
- 发送消息后终端无任何输出
- 说明长连接消息推送未到达。

---

### 4. 发送消息 — 验证消息发送

**命令：**
```bash
npx xabot send --platform feishu --app-id <APP_ID> --app-secret <APP_SECRET> <CHAT_ID> "Hello from xabot CLI"
```

**预期结果：**
```
已发送消息至 oc_xxxxxxxxxxxxx，msgId: om_xxxxxxxxxxxxx
```

**同时在飞书中检查：** 机器人应发来 "Hello from xabot CLI"。

**不通过的表现：**
- `❌ <错误信息>` → 发送失败
- 飞书中没有收到消息
- 检查组件的 `sendMessage` 实现和 API 调用是否正确。

---

### 5. Bridge 模式 — 端到端消息桥接

Bridge 是整个 xabot 的核心：将云端消息转发给 ACP Agent，再将 Agent 回复发回云端。

**启动：**
```bash
npx xabot run \
  --platform feishu \
  --app-id <APP_ID> \
  --app-secret <APP_SECRET> \
  --agent-id agent-1 \
  --chat-ids <CHAT_ID>
```

**预期输出：**
```
Bridge 模式启动，agentId=agent-1，chatIds=[oc_xxxxxxxxxxxxx]
```

**验证流程：**

1. 在飞书中向机器人发消息（如 "hello"）
2. 终端应显示 ACP 收到请求（NDJSON 格式输出到 stdout）
3. 手动通过 stdin 发送一条 ACP 回复：
   ```json
   {"jsonrpc":"2.0","result":{"message":"世界你好"},"id":1}
   ```
4. 飞书中应收到机器人的回复 "世界你好"

**优雅关闭：**
- `Ctrl+C` 或 `kill -TERM <pid>`
- 预期输出：
  ```
  收到 SIGTERM，开始优雅关闭...
  正在关闭 Bridge...
  Bridge 已关闭，退出。
  ```

**不通过的表现：**
- 启动即 crash
- 飞书消息到达后 ACP 端无输出
- ACP 回复后飞书无响应

---

## 微信平台验证

将上述命令中的 `--platform feishu` 替换为 `--platform wechat` 即可验证微信平台。

微信特殊行为：
- `discover` / `listen` 使用长轮询，非 WebSocket
- `health` 通过 `fetchAccessToken` 验证凭据
- Token 有过期缓存，重试前会复用未过期的 token

---

## 验收检查清单

| # | 项目 | 命令 | 状态 |
|---|------|------|------|
| 1 | 健康检查 | `xabot health --platform feishu ...` | ☐ |
| 2 | 发现 chatId | `xabot discover --platform feishu ...` | ☐ |
| 3 | 监听消息 | `xabot listen --platform feishu ...` | ☐ |
| 4 | 发送消息 | `xabot send --platform feishu ... <chatId> "msg"` | ☐ |
| 5 | 发送消息(微信) | `xabot send --platform wechat ... <chatId> "msg"` | ☐ |
| 6 | Bridge 模式 | `xabot run --platform feishu ...` | ☐ |
| 7 | Bridge 优雅关闭 | `SIGTERM` 后正常退出 | ☐ |
| 8 | 单元测试 | `npx vitest run` (202 passed) | ☐ |
| 9 | 类型检查 | `npx tsc --noEmit` (0 errors) | ☐ |

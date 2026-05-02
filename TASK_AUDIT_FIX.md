# xabot 审计修复任务

## P0 — 必须修复（3项）

### 1. Bridge sessionToChat 潜在内存泄漏
**文件:** `src/bridge/index.ts`
**问题:** agentNotificationsLoop 的 finally 只清理最后一个 sessionId 的映射，长期运行会无限膨胀
**修复:**
- 方案A：在 `prompt` 返回后主动清理已完成对话的映射
- 方案B：定期清理（每 N 个 session 做一次 sweep）
- 推荐方案A：在 cloud→agent 循环中，session 映射用完后立即清理（或设 max size 限制 + LRU 淘汰）

### 2. FeishuClient.connect() 对早调 messages() 的 crash
**文件:** `src/platforms/feishu/client.ts:91-95`
**问题:** `this.messageResolve(undefined as any)` 导致 toStandardMessage(undefined) 抛 TypeError
**修复:**
```typescript
if (this.messageResolve) {
  this.messageResolve({
    sender: { sender_type: '' },
    message: { message_id: '', chat_id: '', create_time: '', chat_type: '', message_type: '', content: '' },
  });
  this.messageResolve = null;
}
```
用合法空对象代替 `undefined`。或者更好：检查 resolve 的值再调用 toStandardMessage。

### 3. Connection.startReader 吞掉所有异常
**文件:** `src/acp/session.ts` Connection.startReader
**问题:** `.catch(() => { /* stream closed */ })` 静默吞掉所有异常
**修复:**
```typescript
.catch((err) => {
  if (this.readerStarted) {
    console.error('[AcpSession] reader error:', err);
  }
});
```
至少 log 错误，让 Bridge 能感知异常。

---

## P1 — 应该修复（5项）

### 4. 手写参数解析器末尾缺值 crash
**文件:** `src/config/schema.ts` 和 `src/cli/index.ts`
**问题:** `--platform` 在命令行末尾且无值时 `next = undefined`，`parsePlatformFlags` 同理
**修复:** 在 switch case 中检查 `next !== undefined && !next.startsWith('--')`，否则 throw 友好错误：
```typescript
case '--platform':
  if (!next || next.startsWith('--')) throw new Error('--platform requires a value');
  args.platform = next; i++; break;
```

### 5. AcpHandler 和 AcpSession 监听器重复
**文件:** `src/acp/handler.ts`, `src/acp/session.ts`
**问题:** 两个类各有几乎相同但独立的 listener 管理体系，`proactiveMessages()` 走 handler 的 listener 而 `notifications()` 走 session 的
**修复:** 把 AcpSession 的 notification/permission listeners 合并到 AcpHandler，或至少添加注释说明为什么分离。当前代码可以工作，但维护者会困惑。

### 6. 缺少结构化错误类型
**文件:** 新建 `src/core/error.ts`
**修复:** 创建 XabotError 类（参考 xamail 的 XamailError）：
```typescript
export class XabotError extends Error {
  constructor(msg: string, public readonly code: string = 'UNKNOWN') { super(msg); }
  static platform(msg: string): XabotError { return new XabotError(msg, 'PLATFORM'); }
  static auth(msg: string): XabotError { return new XabotError(msg, 'AUTH'); }
  static acp(msg: string): XabotError { return new XabotError(msg, 'ACP'); }
  static config(msg: string): XabotError { return new XabotError(msg, 'CONFIG'); }
}
```
在 bridge、feishu client、wechat client 的 throw 处替换。

### 7. WechatClient pollLoop 只认 5xx 重试
**文件:** `src/platforms/wechat/client.ts` pollLoop
**问题:** 429/408/502 等理应重试的错误码被 4xx 分支 break 掉
**修复:**
```typescript
// 不可重试的 4xx
if (res.status === 400 || res.status === 403 || res.status === 404) { break; }
// 其他错误（含 5xx + 可重试 4xx）throw 进 backoff 重试
throw new Error(`WechatClient poll error: HTTP ${res.status}`);
```

### 8. Router.agentToChats 残留空数组
**文件:** `src/core/router.ts:28`
**问题:** agent 的 chat 全部被抢走后 agentToChats 仍保留 `agentId → []`
**修复:**
```typescript
if (filtered.length === 0) {
  this.agentToChats.delete(owner);
} else {
  this.agentToChats.set(owner, filtered);
}
```

---

## P2 — 建议修复（3项）

### 9. ProactiveMessage.chatId 用 string 而非 ChannelId
**文件:** `src/acp/handler.ts`
**修复:** `chatId: string` → `chatId: ChannelId`，移除 Bridge 中的 `as ChannelId`

### 10. send_message 参数类型
**文件:** `src/acp/session.ts` Connection.#dispatch
**修复:** `({ chatId: string; content: string })` → 明确类型标注

### 11. WechatClient fetchAccessToken 缺少缓存
**文件:** `src/platforms/wechat/client.ts`
**修复:** 缓存 token + expires_at，未过期前复用，过期再重新获取

---

## 验收标准

- `npx vitest run` 全部通过（≥202 个测试）
- `npx tsc --noEmit` 零错误
- P0-P1 全部修复，P2 至少修 #9

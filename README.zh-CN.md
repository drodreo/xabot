**[English](README.md)**

# xabot

连接 XACPP Agent 与飞书、微信的双向消息桥接工具。

```
云端 IM（飞书 / 微信）←→ xabot ←→ Agent (XACPP)
```

xabot 是 **XACPP Responder** — 被动接受下游 XACPP Initiator 的 establish 请求，在云端 IM 平台与 Agent 之间路由消息。xabot 仅兼容 [XACPP 协议](#xacpp-协议)对等端。

## 安装

```bash
npm install -g xabot
```

或从源码构建：

```bash
git clone https://github.com/drodreo/xabot.git
cd xabot
npm install
npm run build
npm install -g .
```

## 使用

CLI 按平台组织为子命令：

```
xabot feishu --app-id <ID> --app-secret <SECRET> <action>
xabot wechat login
xabot wechat --token <TOKEN> <action>
```

### 命令

| 命令 | 生命周期 | 说明 |
|------|---------|------|
| `login` | 单次 | 仅微信 — 扫码登录，stdout 输出 `{ token, baseUrl }` |
| `health` | 单次 | 验证凭证与连通性 |
| `run` | 长连接 | 正式模式：stdio ↔ 平台双向桥接 |
| `chat` | 长连接 | 交互调试：终端 ↔ Agent ↔ 平台 |

### 飞书

```bash
# 健康检查
xabot feishu --app-id <ID> --app-secret <SECRET> health

# 正式桥接
xabot feishu --app-id <ID> --app-secret <SECRET> run

# 交互式聊天
xabot feishu --app-id <ID> --app-secret <SECRET> chat
```

### 微信

微信采用两阶段连接 — 先登录获取 token，再使用 token：

```bash
# 阶段 1：扫码登录 → stdout 输出 { token, baseUrl }
xabot wechat login

# 阶段 2：使用 token
xabot wechat --token <TOKEN> health
xabot wechat --token <TOKEN> run
xabot wechat --token <TOKEN> chat
```

### chat 终端命令

在 `chat` 模式下，文本输入会被解析为命令或普通消息：

| 输入 | 动作 |
|------|------|
| 纯文本 | 作为 `invoke_activity` 发送给 Agent |
| `/new [prompt]` | 创建新 Activity |
| `/compact` | 压缩当前 Activity 上下文 |
| `/cancel` | 取消当前 Activity |

## 开发

```bash
npm install
npm run build    # 编译 TypeScript → dist/
npm test         # 运行全量测试 (vitest)
```

## 架构

```
xabot/
├── src/
│   ├── core/            # 平台 Client 接口、类型、配对码
│   ├── xacpp/           # XACPP EstablishHandler & SessionHandler
│   ├── platforms/
│   │   ├── feishu/      # 飞书 Client（WebSocket 长连接）
│   │   └── wechat/      # 微信 Client（HTTP 长轮询）
│   ├── bridge/          # 双向消息路由：云端 ↔ XACPP
│   └── cli/             # CLI 入口 & 子命令（commander）
```

核心设计：
- **无持久化** — 凭证通过 CLI 参数传入
- **chatId 通过 Establish 握手获取** — 动态获取，无需硬编码
- **Activity ↔ chatId** — 每个 chatId 对应唯一一个 XACPP activity

## XACPP 协议

xabot 实现 XACPP（eXtensible Agent Control Plane Protocol）的 Responder 侧。下游 Agent 作为 Initiator 连接。

协议 SDK：

| SDK | 语言 | 仓库 |
|-----|------|------|
| xacpp-ts | TypeScript | https://github.com/drodreo/xacpp-ts |
| xacpp-rs | Rust | https://github.com/drodreo/xacpp-rs |

## 许可

MIT

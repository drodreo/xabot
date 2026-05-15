**[English](README.md)**

# xabot

下游 Agent 与云端 IM 之间的桥梁。通过 [XACPP](https://github.com/drodreo/xacpp-ts) 协议连接 Agent，通过平台 SDK 连接云端（飞书/微信），实现双向消息路由。

```
云端 IM ←→ xabot ←→ 下游 Agent (XACPP)
```

**xabot 是 XACPP Responder** — 被动接受下游 Agent（Initiator）的 establish 请求和事件。

## 技术栈

- TypeScript，ESM 模式
- 构建：`tsc` → `dist/`
- 测试：`vitest`
- 运行时依赖：`@larksuiteoapi/node-sdk`、`xacpp`、`commander`、`zod`

## 安装

```bash
npm run build                          # tsc 编译 + npm pack 生成 xabot-1.0.0.tgz
npm install -g ./xabot-1.0.0.tgz       # 全局安装
```

安装后任意目录可直接 `xabot <subcommand>`。

卸载：`npm uninstall -g xabot`

## CLI 子命令

| 子命令 | 生命周期 | 用途 |
|--------|---------|------|
| `health` | 单次 | 凭证/连通性验证 |
| `discover` | 单次（有超时） | 通过配对码获取 chatId |
| `send` | 单次 | 向已知 chatId 发消息 |
| `listen` | 长连接 | 交互式调试：stdin 发送 + 接收平台消息 |
| `run` | 长连接 | 正式工作：云端 ↔ XACPP 双向桥接 |
| `chat` | 长连接 | 交互式聊天：Establish 握手 + 终端与 Agent 对话 |

### 使用示例

```bash
# 健康检查
xabot health --platform feishu --app-id X --app-secret Y

# 通过配对码发现 chatId
xabot discover --platform feishu --app-id X --app-secret Y

# 发送消息
xabot send --platform feishu --app-id X --app-secret Y <CHAT_ID> "Hello"

# 交互式监听
xabot listen --platform feishu --app-id X --app-secret Y --chat-id <CHAT_ID>

# 正式 Bridge 模式
xabot run --platform feishu --app-id X --app-secret Y

# 交互式聊天（Establish 握手 + 对话）
xabot chat --platform feishu --app-id X --app-secret Y
```

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
- **不持久化** — 所有配置（凭证）通过 CLI 参数传入
- **chatId 通过 Establish 握手获取** — bot 在云端消息中匹配 Initiator 的 challenge，动态获得 chatId
- **Activity ↔ chatId 映射** — 每个 chatId 对应唯一一个 XACPP activity
- **三步握手** — Initiator 生成 challenge → 用户发送给 bot → Responder 在云端消息中匹配 → `challenge_required` → initiator 确认 → 创建 session（chatId 作为 credentials）

## 许可

MIT

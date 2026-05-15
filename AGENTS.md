# xabot Agent 指南

## 项目概要

xabot 是下游 Agent 与云端 IM 之间的桥梁。通过 XACPP 协议连接 Agent，通过平台 SDK 连接云端（飞书/微信），实现双向消息路由。

## 技术栈

- TypeScript，ESM 模式
- 构建：`tsc`，产物输出到 `dist/`
- 测试：`vitest`
- 运行时依赖：`@larksuiteoapi/node-sdk`、`xacpp`、`commander`、`zod`

## 常用命令

| 命令 | 用途 |
|------|------|
| `npm run build` | 编译 TypeScript → `dist/` |
| `npm test` | 运行全量测试 |
| `npx xabot <subcommand>` | 本地运行 CLI |

## CLI 子命令

| 子命令 | 生命周期 | 用途 |
|--------|---------|------|
| `health` | 单次 | 凭证/连通性验证 |
| `discover` | 单次（有超时） | 通过配对码获取 chatId |
| `send` | 单次 | 向已知 chatId 发消息 |
| `listen` | 长连接 | 交互式调试：stdin 发送 + 接收平台消息 |
| `run` | 长连接 | 正式工作：云端 ↔ XACPP 双向桥接 |

## 全局安装

构建产物为 `.tgz` 包（由 `npm run build` 自动生成）：

```bash
npm run build                          # tsc 编译 + npm pack 生成 xabot-1.0.0.tgz
npm install -g ./xabot-1.0.0.tgz       # 全局安装
```

安装后任意目录可直接 `xabot <subcommand>`。

卸载：`npm uninstall -g xabot`

## 注意事项

- 所有子命令的平台消息流（飞书 WS / 微信长轮询）均为长连接，进程退出依赖 `process.exit()`（飞书 SDK 存在 `setInterval` 泄漏）
- `discover` 和 `listen` 的人类可读输出走 stderr，结构化结果（JSON）走 stdout

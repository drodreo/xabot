# 飞书机器人配置指南

## 前提条件

- 飞书企业管理员权限（或联系管理员协助操作以下步骤）

## 步骤 1：创建飞书应用

1. 打开飞书开放平台管理后台：[https://open.feishu.cn/app](https://open.feishu.cn/app)
2. 点击「创建自建应用」
3. 填写应用名称和描述，上传图标，点击创建

## 步骤 2：配置机器人能力

1. 进入应用 → 左侧菜单「添加应用能力」
2. 启用「机器人」能力

## 步骤 3：配置权限

1. 进入应用 → 左侧菜单「权限管理」
2. 点击「权限管理」页面上方的「批量导入」按钮
3. 将 [feishu-permissions.json](feishu-permissions.json) 文件中的权限列表粘贴到批量开通输入框中

## 步骤 4：配置事件订阅与回调

1. 进入应用 → 左侧菜单「事件与回调」
2. 在事件配置的订阅方式中选择长连接
3. 添加以下事件：
  - 消息被reaction v2.0：im.message.reaction.created_v1
  - 消息被取消reaction v2.0：im.message.reaction.deleted_v1
  - 消息撤回 v2.0：im.message.recalled_v1
  - 接收消息 v2.0：im.message.receive_v1
4. 在回调配置的订阅方式中选择长连接
4. 添加以下回调：
  - 卡片回传交互：card.action.trigger

## 步骤 5：发布应用

1. 进入应用 → 左侧菜单「版本管理与发布」
2. 创建版本并提交审核（企业自建应用通常自动通过）

## 步骤 6：获取凭证

1. 进入应用 → 左侧菜单「凭证与基础信息」
2. 确认 **App ID** 和 **App Secret** 后，告知助手准备工作已完成

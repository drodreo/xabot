/**
 * xabot 作为 Responder 的 capabilities 声明。
 *
 * 所有 CLI 入口（feishu / wechat / chat）共享同一份声明。
 */
import type { Capabilities } from 'xacpp';

export const XABOT_CAPABILITIES: Capabilities = {
  commands: [
    { name: 'action_request', dispatcher: 'bridge' },
    {
      name: 'question',
      dispatcher: 'tool',
      description: '向用户发起提问并获取回答。需要用户确认信息或做出选择时使用此工具。所有提问，系统都会提供默认的"其他"选项，严禁重复提供。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '问题内容（必填）',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            default: [],
            description: '选项列表，空数组表示无预设选项，UI 会默认提供"是"、"否"、"其他"',
          },
        },
        required: ['question'],
      },
    },
    { name: 'message' },
    {
      name: 'report_to_user',
      dispatcher: 'tool',
      extraScopes: ['compact'],
      description: '回复用户的唯一通道。一轮任务（round）结束前必须至少调用一次。只发送面向用户的最终回复本身；严禁通过本工具发送中间行动过程或思考过程。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'array',
            description: '报告内容分片，按展示顺序排列。每个元素只带一个字段：text（文本内容）或 image/audio/video/file（本机文件绝对路径）',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '文本内容' },
                image: { type: 'string', description: '图片文件绝对路径' },
                audio: { type: 'string', description: '音频文件绝对路径' },
                video: { type: 'string', description: '视频文件绝对路径' },
                file: { type: 'string', description: '文件绝对路径（文档/压缩包等任意类型）' },
              },
            },
          },
        },
        required: ['content'],
      },
      evaluationPolicy: {
        requireToolCall: {
          require: 'report_to_user',
          on_failure:
            '你本轮尚未调用 report_to_user。注意：用户看不到你在 report_to_user 工具调用之外输出的任何内容——你此前的所有输出都未送达用户。请梳理自最后一次用户输入以来你给出的全部内容，重新组织成一段完整的回复，像首次回复用户一样，通过 report_to_user 发送。',
        },
      },
    },
  ],
  produceEvents: [],
  acceptEvents: [
    { name: 'start' },
    { name: 'think_start' },
    { name: 'think' },
    { name: 'think_end' },
    { name: 'think_part' },
    { name: 'content_start' },
    { name: 'content_delta' },
    { name: 'content_part' },
    { name: 'content_end' },
    { name: 'tool_use' },
    { name: 'tool_result' },
    { name: 'pair_complete' },
    { name: 'info' },
    { name: 'warn' },
    { name: 'error' },
    { name: 'notify' },
    { name: 'security_alert' },
    { name: 'upload' },
    { name: 'complete' },
    { name: 'waiting_command' },
    { name: 'activity_start' },
    { name: 'activity_updates' },
    { name: 'activity_done' },
    { name: 'activity_aborted' },
  ],
};

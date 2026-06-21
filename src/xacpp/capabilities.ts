/**
 * xabot 作为 Responder 的 capabilities 声明。
 *
 * 所有 CLI 入口（feishu / wechat / chat）共享同一份声明。
 */
import type { Capabilities } from 'xacpp';

export const XABOT_CAPABILITIES: Capabilities = {
  commands: [
    { name: 'action_request' },
    { name: 'question' },
    { name: 'sensitive_info_operation' },
    { name: 'message' },
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

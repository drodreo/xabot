import type { ChannelId } from '../core/types.js';
import type { PlatformClient } from '../core/client.js';
import type { XacppSession, XacppTransport, XacppActivityEvent, XacppCommand, XacppResponse, ContentPart } from 'xacpp';

/**
 * Bridge — bidirectional message loop between cloud platform and XACPP agents.
 *
 * Cloud → Agent: reads cloud messages, resolves/creates activity,
 *   sends invoke_activity command via session.
 * Agent → Cloud: reads agent events, routes content_delta/complete/notify
 *   back to the corresponding chatId.
 */
export class Bridge {
  private readonly cloud: PlatformClient;
  private readonly transport: XacppTransport;

  /** chatId → activityId */
  private readonly chatToActivity = new Map<ChannelId, string>();
  /** activityId → chatId */
  private readonly activityToChat = new Map<string, ChannelId>();

  /** establish 后获得，用于主动发 command/event */
  private session: XacppSession | null = null;

  /** 阻塞等待的 pending response：requestId → resolve */
  private readonly pendingResponses = new Map<string, (response: XacppResponse) => void>();

  private abortCtrl = new AbortController();
  private closed = false;

  constructor(cloud: PlatformClient, transport: XacppTransport) {
    this.cloud = cloud;
    this.transport = transport;
  }

  /** establish 成功后调用，注入 session 引用。 */
  setSession(session: XacppSession): void {
    this.session = session;
  }

  /** 处理下游 Agent 发来的 Command（通过 XabotSessionHandler.onCommand 转发）。 */
  async handleCommand(_command: XacppCommand): Promise<XacppResponse> {
    // xabot 是 Responder，暂不主动处理 inbound command
    return { kind: 'acknowledge' };
  }

  /** 处理下游 Agent 发来的 Event（通过 XabotSessionHandler.onEvent 转发）。 */
  async handleEvent(activityId: string, event: XacppActivityEvent): Promise<XacppResponse> {
    const chatId = this.activityToChat.get(activityId);

    switch (event.event.type) {
      case 'content_delta':
      case 'content_part': {
        if (!chatId) return { kind: 'acknowledge' };
        const payload = event.event.payload as ContentPart;
        if (payload.type === 'text') {
          await this.cloud.send(chatId, { type: 'text', text: payload.text });
        } else if (payload.type === 'image') {
          await this.cloud.send(chatId, { type: 'image', url: payload.source.remoteUrl });
        } else {
          await this.cloud.send(chatId, { type: 'text', text: `[${payload.type}]` });
        }
        return { kind: 'acknowledge' };
      }

      case 'complete': {
        if (!chatId) return { kind: 'acknowledge' };
        for (const part of event.event.assistantReply) {
          if (part.type === 'text') {
            await this.cloud.send(chatId, { type: 'text', text: part.text });
          } else if (part.type === 'image') {
            await this.cloud.send(chatId, { type: 'image', url: part.source.remoteUrl });
          } else {
            await this.cloud.send(chatId, { type: 'text', text: `[${part.type}]` });
          }
        }
        return { kind: 'acknowledge' };
      }

      case 'notify': {
        if (!chatId) return { kind: 'acknowledge' };
        await this.cloud.send(chatId, { type: 'text', text: event.event.message });
        return { kind: 'acknowledge' };
      }

      case 'action_request': {
        if (!chatId) return { kind: 'acknowledge' };
        const pendingPromise = this.waitForResponse(event.event.requestId);
        try {
          const userMessage = `[授权请求] ${event.event.description}\n工具: ${event.event.toolName}\n请回复 approve 或 reject`;
          await this.cloud.send(chatId, { type: 'text', text: userMessage });
        } catch {
          this.pendingResponses.delete(event.event.requestId);
          return { kind: 'error', code: 'send_failed', message: 'failed to forward action_request to cloud' };
        }
        return pendingPromise;
      }

      case 'question': {
        if (!chatId) return { kind: 'acknowledge' };
        const pendingPromise = this.waitForResponse(event.event.requestId);
        try {
          const questionMsg = `[提问] ${event.event.question}\n选项: ${event.event.options.join(', ')}`;
          await this.cloud.send(chatId, { type: 'text', text: questionMsg });
        } catch {
          this.pendingResponses.delete(event.event.requestId);
          return { kind: 'error', code: 'send_failed', message: 'failed to forward question to cloud' };
        }
        return pendingPromise;
      }

      case 'sensitive_info_operation': {
        if (!chatId) return { kind: 'acknowledge' };
        const pendingPromise = this.waitForResponse(event.event.requestId);
        try {
          const opMsg = `[敏感信息操作] ${event.event.operation.type}`;
          await this.cloud.send(chatId, { type: 'text', text: opMsg });
        } catch {
          this.pendingResponses.delete(event.event.requestId);
          return { kind: 'error', code: 'send_failed', message: 'failed to forward sensitive_info_operation to cloud' };
        }
        return pendingPromise;
      }

      case 'info':
      case 'warn':
      case 'error': {
        return { kind: 'acknowledge' };
      }

      default: {
        return { kind: 'acknowledge' };
      }
    }
  }

  /** 解除阻塞等待的 action/question/sensitive_info_operation。 */
  resolvePending(requestId: string, response: XacppResponse): void {
    const resolve = this.pendingResponses.get(requestId);
    if (resolve) {
      this.pendingResponses.delete(requestId);
      resolve(response);
    }
  }

  /** 云端消息循环：PlatformClient.messages() → session.requestCommand */
  async run(): Promise<void> {
    if (this.closed) return;

    const { signal } = this.abortCtrl;

    try {
      for await (const msg of this.cloud.messages()) {
        if (signal.aborted) break;
        if (!this.session) {
          continue;
        }

        const chatId = msg.chatId;

        // 查找或创建 activityId
        let activityId = this.chatToActivity.get(chatId);
        if (!activityId) {
          const createResponse = await this.session.requestCommand({
            new_activity: { title: null },
          });
          if (createResponse.kind === 'activity_created') {
            activityId = createResponse.activity;
          } else {
            continue;
          }
          this.chatToActivity.set(chatId, activityId);
          this.activityToChat.set(activityId, chatId);
        }

        // 构造 ContentPart
        const parts: ContentPart[] = [];
        if (msg.content.type === 'text') {
          parts.push({ type: 'text', text: msg.content.text });
        } else if (msg.content.type === 'image') {
          parts.push({
            type: 'image',
            source: { remoteUrl: msg.content.url, localUri: '', mimeType: 'image/*', sizeBytes: 0 },
          });
        } else if (msg.content.type === 'file') {
          parts.push({
            type: 'text',
            text: `[file: ${(msg.content as { name: string }).name}]`,
          });
        }

        await this.session.requestCommand({
          invoke_activity: { activity: activityId, messages: parts },
        });
      }
    } catch (err) {
      console.error('[Bridge] cloud message loop error:', err);
      this.abortCtrl.abort();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortCtrl.abort();
    this.chatToActivity.clear();
    this.activityToChat.clear();
    for (const [, resolve] of this.pendingResponses) {
      resolve({ kind: 'error', code: 'cancelled', message: 'Bridge closing' });
    }
    this.pendingResponses.clear();
    await Promise.all([
      this.cloud.close(),
      this.transport.disconnect(),
    ]);
  }

  /** 阻塞等待指定 requestId 的 response。 */
  private waitForResponse(requestId: string): Promise<XacppResponse> {
    return new Promise<XacppResponse>((resolve) => {
      this.pendingResponses.set(requestId, resolve);
    });
  }
}

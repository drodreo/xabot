import type { ChannelId } from '../core/types.js';
import type { PlatformClient } from '../core/client.js';
import type { XacppSession, XacppTransport, XacppActivityEvent, XacppCommand, XacppResponse, ContentPart } from 'xacpp';
import { parseInput } from './input-parser.js';

/**
 * Bridge — bidirectional message loop between cloud platform and XACPP agents.
 *
 * Cloud → Agent: reads cloud messages, resolves/creates activity,
 *   sends invoke_activity command via session.
 * Agent → Cloud: reads agent events, routes content_delta/complete/notify
 *   back to the corresponding chatId.
 */
export class Bridge {
  private cloud: PlatformClient | null = null;
  private readonly transport: XacppTransport;
  private readonly cloudReady: Promise<void>;
  private cloudReadyResolve: (() => void) | null = null;

  /** chatId → activityId */
  private readonly chatToActivity = new Map<ChannelId, string>();

  /** Obtained after establish, used to proactively send command/event */
  private session: XacppSession | null = null;

  /** chatId bound to the established session (from session.credentials) */
  private sessionChatId: ChannelId | null = null;

  /** Pending responses awaiting resolution: requestId → resolve */
  private readonly pendingResponses = new Map<string, (response: XacppResponse) => void>();

  private abortCtrl = new AbortController();
  private closed = false;

  /** Whether the establish handshake has completed. */
  private established = false;

  /** Reference to the establish handler — Phase 1 feeds discovered challenges to it. */
  private establishHandler: { submitChallenge(challenge: string, chatId: ChannelId): void } | null = null;

  constructor(transport: XacppTransport, options?: { cloud?: PlatformClient }) {
    this.transport = transport;
    if (options?.cloud) {
      this.cloud = options.cloud;
      this.cloudReady = Promise.resolve();
    } else {
      this.cloudReady = new Promise<void>((resolve) => {
        this.cloudReadyResolve = resolve;
      });
    }
  }

  /** Replace the cloud PlatformClient (used after Establish login creates a new client). */
  replaceCloud(cloud: PlatformClient): void {
    this.cloud = cloud;
    if (this.cloudReadyResolve) {
      this.cloudReadyResolve();
      this.cloudReadyResolve = null;
    }
  }

  /** Call after establish succeeds to inject session reference. */
  setSession(session: XacppSession): void {
    this.session = session;
    // Extract chatId from credentials — WeChat uses JSON, Feishu uses plain string
    const raw = session.credentials as string;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && 'chatId' in parsed) {
        this.sessionChatId = (parsed as { chatId: string }).chatId as ChannelId;
      } else {
        this.sessionChatId = raw as ChannelId;
      }
    } catch {
      this.sessionChatId = raw as ChannelId;
    }
  }

  /** Set the establish handler — Phase 1 feeds discovered challenges to it. */
  setEstablishHandler(handler: { submitChallenge(challenge: string, chatId: ChannelId): void }): void {
    this.establishHandler = handler;
  }

  /** Handle Command from downstream Agent (forwarded via XabotSessionHandler.onCommand). */
  async handleCommand(command: XacppCommand): Promise<XacppResponse> {
    if (!this.cloud) return { kind: 'acknowledge' };
    if (typeof command === 'object' && 'message' in command) {
      const chatId = this.sessionChatId;
      if (!chatId) return { kind: 'acknowledge' };
      for (const part of command.message.content) {
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
    return { kind: 'acknowledge' };
  }

  /** Handle Event from downstream Agent (forwarded via XabotSessionHandler.onEvent). */
  async handleEvent(_activityId: string, event: XacppActivityEvent): Promise<XacppResponse> {
    if (!this.cloud) return { kind: 'acknowledge' };
    const chatId = this.sessionChatId;

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
          const userMessage = `[Authorization Request] ${event.event.description}\nTool: ${event.event.toolName}\nReply approve or reject`;
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
          const questionMsg = `[Question] ${event.event.question}\nOptions: ${event.event.options.join(', ')}`;
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
          const opMsg = `[Sensitive Info Operation] ${event.event.operation.type}`;
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

  /** Resolve a pending action/question/sensitive_info_operation. */
  resolvePending(requestId: string, response: XacppResponse): void {
    const resolve = this.pendingResponses.get(requestId);
    if (resolve) {
      this.pendingResponses.delete(requestId);
      resolve(response);
    }
  }

  /** Cloud message loop: two-phase consumption. */
  async run(): Promise<void> {
    if (this.closed) return;
    await this.cloudReady;
    if (this.closed || !this.cloud) return;

    const { signal } = this.abortCtrl;

    try {
      for await (const msg of this.cloud!.messages()) {
        if (signal.aborted) break;

        // Phase 1: pre-establish — scan for challenge messages
        if (!this.established) {
          if (msg.content.type === 'text') {
            this.establishHandler?.submitChallenge(msg.content.text, msg.chatId);
          }
          // Continue consuming — don't route to session yet
          continue;
        }

        // Phase 2: post-establish — normal activity routing
        if (!this.session) {
          continue;
        }

        const chatId = msg.chatId;

        // ── Text messages: parse and dispatch by kind ─────────────────────
        if (msg.content.type === 'text') {
          const parsed = parseInput(msg.content.text);
          switch (parsed.kind) {
            case 'new': {
              this.chatToActivity.delete(chatId);
              const createResponse = await this.session.requestCommand({
                new_activity: { title: '' },
              });
              if (createResponse.kind === 'activity_ready') {
                const newActivityId = createResponse.activity;
                this.chatToActivity.set(chatId, newActivityId);
                if (parsed.prompt) {
                  await this.session.requestCommand({
                    invoke_activity: {
                      activity: newActivityId,
                      messages: [{ type: 'text', text: parsed.prompt }],
                    },
                  });
                }
              }
              continue;
            }

            case 'compact': {
              let activityId = this.chatToActivity.get(chatId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand('last_activity');
                if (lastResponse.kind === 'activity_ready') {
                  activityId = lastResponse.activity;
                  this.chatToActivity.set(chatId, activityId);
                } else {
                  await this.cloud.send(chatId, { type: 'text', text: '当前暂无活动中的对话' });
                  continue;
                }
              }
              await this.session.requestCommand({
                compact_activity: { activity: activityId },
              });
              continue;
            }

            case 'cancel': {
              let activityId = this.chatToActivity.get(chatId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand('last_activity');
                if (lastResponse.kind === 'activity_ready') {
                  activityId = lastResponse.activity;
                  this.chatToActivity.set(chatId, activityId);
                } else {
                  await this.cloud.send(chatId, { type: 'text', text: '当前暂无活动中的对话' });
                  continue;
                }
              }
              await this.session.requestCommand({
                cancel_activity: { activity: activityId },
              });
              continue;
            }

            case 'unknown_command': {
              await this.cloud.send(chatId, {
                type: 'text',
                text: `未知命令: ${parsed.command}，支持的命令: /new, /compact, /cancel`,
              });
              continue;
            }

            case 'invoke': {
              let activityId = this.chatToActivity.get(chatId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand('last_activity');
                if (lastResponse.kind === 'activity_ready') {
                  activityId = lastResponse.activity;
                } else {
                  const createResponse = await this.session.requestCommand({
                    new_activity: { title: '' },
                  });
                  if (createResponse.kind === 'activity_ready') {
                    activityId = createResponse.activity;
                  } else {
                    continue;
                  }
                }
                this.chatToActivity.set(chatId, activityId);
              }
              await this.session.requestCommand({
                invoke_activity: {
                  activity: activityId,
                  messages: [{ type: 'text', text: parsed.text }],
                },
              });
              continue;
            }
          }
        }

        // ── Non-text messages: existing behavior ──────────────────────────
        let activityId = this.chatToActivity.get(chatId);
        if (!activityId) {
          const lastResponse = await this.session.requestCommand('last_activity');
          if (lastResponse.kind === 'activity_ready') {
            activityId = lastResponse.activity;
          } else {
            const createResponse = await this.session.requestCommand({
              new_activity: { title: '' },
            });
            if (createResponse.kind === 'activity_ready') {
              activityId = createResponse.activity;
            } else {
              continue;
            }
          }
          this.chatToActivity.set(chatId, activityId);
        }

        const parts: ContentPart[] = [];
        if (msg.content.type === 'image') {
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

  /** Mark the establish handshake as completed — switches to Phase 2 routing. */
  markEstablished(): void {
    this.established = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortCtrl.abort();
    this.chatToActivity.clear();
    for (const [, resolve] of this.pendingResponses) {
      resolve({ kind: 'error', code: 'cancelled', message: 'Bridge closing' });
    }
    this.pendingResponses.clear();
    if (this.cloudReadyResolve) {
      this.cloudReadyResolve();
      this.cloudReadyResolve = null;
    }
    await Promise.all([
      this.cloud?.close(),
      this.transport.disconnect(),
    ]);
  }

  /** Wait for a response with the specified requestId. */
  private waitForResponse(requestId: string): Promise<XacppResponse> {
    return new Promise<XacppResponse>((resolve) => {
      this.pendingResponses.set(requestId, resolve);
    });
  }
}

import type { ChannelId, UserId } from '../core/types.js';
import { StreamCapability } from '../core/types.js';
import type { PlatformClient } from '../core/client.js';
import type { XacppSession, XacppTransport, XacppActivityEvent, XacppCommand, XacppResponse, ContentPart, ActionRequestPayload, QuestionPayload, SensitiveInfoOperationPayload, NotifyPayload } from 'xacpp';
import { acknowledge, genericResponse, errorResponse, genericCommand, commandName } from 'xacpp';
import { parseInput } from './input-parser.js';
import { i18nResource } from '../i18n/index.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('Bridge');
import type { MessageId } from '../core/types.js';

interface PendingItem {
  requestId: string;
  type: 'action_request' | 'question' | 'sensitive_info_operation';
  chatId: ChannelId;
  senderId: UserId;
  eventPayload: ActionRequestPayload | QuestionPayload | SensitiveInfoOperationPayload;
  resolve: (response: XacppResponse) => void;
}

interface PendingQueue {
  active: PendingItem | null;
  queue: PendingItem[];
}

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

  /** chatId → (senderId → activityId) */
  private readonly chatUserToActivity = new Map<ChannelId, Map<UserId, string>>();
  /** activityId → { chatId, senderId } */
  private readonly activityToTarget = new Map<string, { chatId: ChannelId; senderId: UserId }>();

  /** Obtained after establish, used to proactively send command/event */
  private session: XacppSession | null = null;

  /** chatId bound to the established session (from session.credentials) */
  private sessionChatId: ChannelId | null = null;

  /** targetKey (chatId:senderId) → pending queue state */
  private readonly pendingQueues = new Map<string, PendingQueue>();

  /** targetKey → buffered media ContentParts awaiting next text invoke */
  private readonly pendingMediaByTarget = new Map<string, ContentPart[]>();

  private abortCtrl = new AbortController();
  private closed = false;
  private runPromise: Promise<void> | null = null;

  /** Whether the establish handshake has completed. */
  private established = false;

  /** Reference to the establish handler — Phase 1 feeds discovered challenges to it. */
  private establishHandler: { submitChallenge(challenge: string, chatId: ChannelId): void } | null = null;

  private verbose: boolean;

  constructor(transport: XacppTransport, options?: { cloud?: PlatformClient; verbose?: boolean }) {
    this.transport = transport;
    this.verbose = options?.verbose ?? false;
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

  /** Generate targetKey for pending queue lookup. */
  private targetKey(chatId: ChannelId, senderId: UserId): string {
    return `${chatId}:${senderId}`;
  }

  /** Get or create pending queue for a target. */
  private ensureQueue(key: string): PendingQueue {
    let pq = this.pendingQueues.get(key);
    if (!pq) {
      pq = { active: null, queue: [] };
      this.pendingQueues.set(key, pq);
    }
    return pq;
  }

  /** Create a PendingItem from an event. */
  private createPendingItem(
    chatId: ChannelId, senderId: UserId,
    type: 'action_request' | 'question' | 'sensitive_info_operation',
    eventPayload: ActionRequestPayload | QuestionPayload | SensitiveInfoOperationPayload,
  ): PendingItem {
    return { requestId: eventPayload.requestId, type, chatId, senderId, eventPayload, resolve: () => {} };
  }

  /** Format action_request for cloud display. */
  private formatActionMessage(payload: ActionRequestPayload): string {
    const alertLabel = payload.alert === 'critical' ? '🔴' : payload.alert === 'warn' ? '🟡' : 'ℹ️';
    return [
      `${alertLabel} [请求授权] ${payload.intent || payload.description}`,
      `工具：${payload.toolName}`,
      payload.arguments ? `参数：${payload.arguments}` : '',
      '───────────────',
      'a: 始终允许 | y: 单次允许',
      'c: 取消执行',
      '直接输入文本即拒绝（文本将作为拒绝原因）',
    ].filter(Boolean).join('\n');
  }

  /** Format question for cloud display. */
  private formatQuestionMessage(payload: QuestionPayload): string {
    const lines = [`❓ [提问] ${payload.question}`];
    if (payload.options.length > 0) {
      lines.push('选项：');
      payload.options.forEach((opt, i) => lines.push(`  ${i + 1}. ${opt}`));
      lines.push('───────────────');
      lines.push(`回复 1~${payload.options.length} 选择选项，或直接输入文本`);
      lines.push('c: 取消执行');
    } else {
      lines.push('───────────────');
      lines.push('直接输入回答');
      lines.push('c: 取消执行');
    }
    return lines.join('\n');
  }

  /** Format sensitive_info_operation for cloud display. */
  private formatSensitiveInfoMessage(payload: SensitiveInfoOperationPayload): string {
    const lines = [`🔒 [敏感信息操作] ${payload.operation.type}`];
    const items = payload.operation.items;
    lines.push('信息项：');
    items.forEach((item, i) => lines.push(`  ${i + 1}. ${item.displayText} (${item.siType})`));
    lines.push('───────────────');
    lines.push('逐行回复值（每行对应一项） | t: 取消执行');
    return lines.join('\n');
  }

  /** Format TraceableEvent (info/warn/error) for cloud display. */
  private formatTraceable(icon: string, data: { title: string; content: string }): string {
    const title = i18nResource(data.title?.trim() || '');
    const content = i18nResource(data.content?.trim() || '');
    if (title && content) return `${icon} ${title}\n${content}`;
    return `${icon} ${title || content}`;
  }

  /** Parse user text into a pending response, or null if unrecognized. */
  private tryParsePendingResponse(item: PendingItem, text: string): XacppResponse | null {
    const input = text.trim().toLowerCase();

    switch (item.type) {
      case 'action_request': {
        if (input === 'a') return genericResponse("action", { requestId: item.requestId, type: 'approve_always' });
        if (input === 'y') return genericResponse("action", { requestId: item.requestId, type: 'approve' });
        if (input === 'c') return genericResponse("action", { requestId: item.requestId, type: 'reject', reason: '用户取消执行' });
        return genericResponse("action", { requestId: item.requestId, type: 'reject', reason: text.trim() });
      }

      case 'question': {
        const payload = item.eventPayload as QuestionPayload;
        if (input === 'c') return genericResponse("question", { requestId: item.requestId, type: 'skip', reason: '用户取消执行' });
        if (payload.options.length > 0) {
          const num = parseInt(input, 10);
          if (!isNaN(num) && num >= 1 && num <= payload.options.length) {
            return genericResponse("question", { requestId: item.requestId, type: 'answer', content: payload.options[num - 1]! });
          }
        }
        return genericResponse("question", { requestId: item.requestId, type: 'answer', content: text.trim() });
      }

      case 'sensitive_info_operation': {
        const siPayload = item.eventPayload as SensitiveInfoOperationPayload;
        if (input === 'c') {
          const results = siPayload.operation.items.map((itm) =>
            siPayload.operation.type === 'collect'
              ? { type: 'collect_skipped' as const, key: itm.key, reason: '用户取消执行' }
              : { type: 'delete_rejected' as const, id: itm.id ?? '', reason: '用户取消执行' }
          );
          return genericResponse("sensitive_info_operation", { requestId: item.requestId, results });
        }
        const lines = text.trim().split('\n');
        const items = siPayload.operation.items;
        if (siPayload.operation.type === 'collect') {
          const results = items.map((itm: { key: string }, i: number) => {
            const value = lines[i]?.trim() ?? '';
            return value
              ? { type: 'provided' as const, key: itm.key, value }
              : { type: 'collect_skipped' as const, key: itm.key, reason: '未提供值' };
          });
          return genericResponse("sensitive_info_operation", { requestId: item.requestId, results });
        }
        const results = items.map((itm: { id?: string }) => ({ type: 'deleted' as const, id: itm.id ?? '' }));
        return genericResponse("sensitive_info_operation", { requestId: item.requestId, results });
      }
    }
  }

  /** Get or create senderId→activityId sub-map for a chatId. */
  private ensureUserMap(chatId: ChannelId): Map<UserId, string> {
    let map = this.chatUserToActivity.get(chatId);
    if (!map) {
      map = new Map();
      this.chatUserToActivity.set(chatId, map);
    }
    return map;
  }

  /** Look up activityId for (chatId, senderId). */
  private getActivityForUser(chatId: ChannelId, senderId: UserId): string | undefined {
    return this.chatUserToActivity.get(chatId)?.get(senderId);
  }

  /** Bind activityId ↔ (chatId, senderId) bidirectionally. */
  private bindActivity(chatId: ChannelId, senderId: UserId, activityId: string): void {
    this.ensureUserMap(chatId).set(senderId, activityId);
    this.activityToTarget.set(activityId, { chatId, senderId });
  }

  /** Unbind activityId for (chatId, senderId). */
  private unbindActivity(chatId: ChannelId, senderId: UserId): void {
    const userMap = this.chatUserToActivity.get(chatId);
    if (!userMap) return;
    const oldActivityId = userMap.get(senderId);
    userMap.delete(senderId);
    if (userMap.size === 0) this.chatUserToActivity.delete(chatId);
    if (oldActivityId) this.activityToTarget.delete(oldActivityId);
  }

  /** activityId → state (processingMessageId, thinkingStart, toolActiveStart, expressingStart) */
  private readonly activityStates = new Map<string, {
    processingMessageId?: MessageId;
    thinkingStart?: number;
    toolActiveStart?: number;
    expressingStart?: number;
  }>();

  private async setTypingIndicatorIfNeeded(chatId: ChannelId, senderId: UserId, activityId: string, messageId: MessageId): Promise<void> {
    if (!this.cloud) return;
    let state = this.activityStates.get(activityId);
    if (!state) {
      state = {};
      this.activityStates.set(activityId, state);
    }
    state.processingMessageId = messageId;
    try {
      await this.cloud.setTypingIndicator(chatId, senderId, messageId);
    } catch (err) {
      log.debug('setTypingIndicator failed: %s', err);
    }
  }

  private async releaseTypingIndicatorForActivity(chatId: ChannelId, senderId: UserId, activityId: string): Promise<void> {
    if (!this.cloud) return;
    const state = this.activityStates.get(activityId);
    const msgId = state?.processingMessageId;
    if (msgId === undefined) return;
    delete state!.processingMessageId;
    try {
      await this.cloud.releaseTypingIndicator(chatId, senderId, msgId);
    } catch (err) {
      log.debug('releaseTypingIndicator failed: %s', err);
    }
  }

  private async endThinking(_chatId: ChannelId, activityId: string): Promise<void> {
    const state = this.activityStates.get(activityId);
    if (!state?.thinkingStart) return;
    // Elapsed time available for future use: (Date.now() - state.thinkingStart) / 1000
    delete state.thinkingStart;
  }

  /** Send a single ContentPart to the cloud platform. */
  private async _sendContentPart(chatId: ChannelId, senderId: UserId, activityId: string, part: ContentPart): Promise<void> {
    if (!this.cloud) return;
    if (part.type === 'text') {
      log.debug('→ cloud send: text (chatId=%s)', chatId);
      await this.cloud.send(chatId, { type: 'text', text: part.text });
    } else {
      const src = part.source;
      if (src.localUri || src.remoteUrl) {
        log.info('→ cloud send: %s (chatId=%s)', part.type, chatId);
        await this.cloud.send(chatId, { type: part.type, source: src });
      } else {
        log.warn('→ cloud send: %s fallback to text — no source (chatId=%s)', part.type, chatId);
        await this.cloud.send(chatId, { type: 'text', text: `[${part.type}]` });
      }
    }
  }

  /** Route interaction command to pending queue. Shared by handleCommand for action_request/question/sensitive_info_operation. */
  private async _handleInteractionCommand(
    type: 'action_request' | 'question' | 'sensitive_info_operation',
    payload: ActionRequestPayload | QuestionPayload | SensitiveInfoOperationPayload,
  ): Promise<XacppResponse> {
    if (!this.cloud) return acknowledge();

    // Look up target from activity
    const target = this.activityToTarget.get(payload.activity);
    if (!target) return acknowledge();
    const { chatId, senderId } = target;

    const key = this.targetKey(chatId, senderId);
    const pq = this.ensureQueue(key);
    const item = this.createPendingItem(chatId, senderId, type, payload);
    const pendingPromise = new Promise<XacppResponse>((resolve) => { item.resolve = resolve; });

    if (!pq.active) {
      pq.active = item;
      try {
        let message: string;
        switch (type) {
          case 'action_request': message = this.formatActionMessage(payload as ActionRequestPayload); break;
          case 'question': message = this.formatQuestionMessage(payload as QuestionPayload); break;
          case 'sensitive_info_operation': message = this.formatSensitiveInfoMessage(payload as SensitiveInfoOperationPayload); break;
        }
        await this.cloud.send(chatId, { type: 'text', text: message });
      } catch {
        pq.active = null;
        item.resolve(errorResponse('send_failed', `failed to forward ${type} to cloud`));
      }
    } else {
      pq.queue.push(item);
    }
    return pendingPromise;
  }

  /** Handle Command from downstream Agent (forwarded via XabotSessionHandler.onCommand). */
  async handleCommand(command: XacppCommand): Promise<XacppResponse> {
    if (!this.cloud) return acknowledge();

    const name = commandName(command);

    // Message command: agent sends content directly to the session's chatId
    if (name === 'message' && typeof command === 'object' && 'generic' in command) {
      const chatId = this.sessionChatId;
      if (!chatId) return acknowledge();
      const args = command.generic.arguments as { content: ContentPart[] };
      for (const part of args.content) {
        await this._sendContentPart(chatId, '' as UserId, '', part);
      }
      return acknowledge();
    }

    // Interaction commands (moved from Event to Command in xacpp 0.7.x)
    if (typeof command === 'object' && 'generic' in command) {
      const args = command.generic.arguments as Record<string, unknown>;
      switch (name) {
        case 'action_request':
          return this._handleInteractionCommand('action_request', args as unknown as ActionRequestPayload);
        case 'question':
          return this._handleInteractionCommand('question', args as unknown as QuestionPayload);
        case 'sensitive_info_operation':
          return this._handleInteractionCommand('sensitive_info_operation', args as unknown as SensitiveInfoOperationPayload);
      }
    }

    return acknowledge();
  }

  /** Handle Event from downstream Agent (forwarded via XabotSessionHandler.onEvent). */
  async handleEvent(activityId: string, event: XacppActivityEvent): Promise<XacppResponse> {
    if (!this.cloud) return acknowledge();
    const target = this.activityToTarget.get(activityId);
    if (!target) return acknowledge();
    const { chatId } = target;

    const eventName = event.event.name;
    const data = event.event.data as Record<string, unknown>;

    // Non-think events end the thinking phase
    if (eventName !== 'think') {
      const state = this.activityStates.get(activityId);
      if (state?.thinkingStart) {
        await this.endThinking(chatId, activityId);
      }
    }

    // Non-content_delta events clear expressing phase
    if (eventName !== 'content_delta') {
      const state = this.activityStates.get(activityId);
      if (state?.expressingStart !== undefined) {
        delete state.expressingStart;
      }
    }

    // Handle typing indicator: refresh for non-complete, release for complete
    if (eventName === 'complete') {
      const state = this.activityStates.get(activityId);
      if (state?.processingMessageId !== undefined) {
        await this.cloud.releaseTypingIndicator(chatId, target.senderId, state.processingMessageId);
        delete state.processingMessageId;
      }
    } else {
      try {
        await this.cloud.refreshTypingIndicator(chatId, target.senderId);
      } catch (err) {
        log.debug('refreshTypingIndicator failed: %s', err);
      }
    }

    switch (eventName) {
      case 'think': {
        if (!chatId) return acknowledge();
        let state = this.activityStates.get(activityId);
        if (!state) {
          state = {};
          this.activityStates.set(activityId, state);
        }
        if (state.thinkingStart === undefined) {
          state.thinkingStart = Date.now();
          if (this.verbose) {
            try {
              await this.cloud.send(chatId, { type: 'text', text: '💭 正在思考...' });
            } catch (err) {
              log.debug('think indicator send failed: %s', err);
            }
          }
        }
        return acknowledge();
      }

      case 'content_delta': {
        if (!chatId) return acknowledge();
        // content_delta is only emitted in streaming mode — forward only on streaming platforms
        if (this.cloud!.streamCapability() === StreamCapability.NonStreaming) {
          return acknowledge();
        }
        let state = this.activityStates.get(activityId);
        if (!state) {
          state = {};
          this.activityStates.set(activityId, state);
        }
        if (state.expressingStart === undefined) {
          state.expressingStart = Date.now();
          try {
            await this.cloud.send(chatId, { type: 'text', text: '正在组织表达...' });
          } catch (err) {
            log.debug('expressing indicator send failed: %s', err);
          }
        }
        const payload = data.payload as ContentPart;
        await this._sendContentPart(chatId, target.senderId, activityId, payload);
        return acknowledge();
      }

      case 'content_part': {
        if (!chatId) return acknowledge();
        // content_part is emitted in non-streaming mode — forward only if verbose
        if (this.verbose) {
          const payload = data.payload as ContentPart;
          await this._sendContentPart(chatId, target.senderId, activityId, payload);
        }
        return acknowledge();
      }

      case 'tool_result': {
        if (!chatId) return acknowledge();
        if (data.toolName === 'send_file') {
          for (const part of (data.parts as ContentPart[])) {
            await this._sendContentPart(chatId, target.senderId, activityId, part);
          }
        }
        return acknowledge();
      }

      case 'complete': {
        for (const part of (data.assistantReply as ContentPart[])) {
          await this._sendContentPart(chatId, target.senderId, activityId, part);
        }
        return acknowledge();
      }

      case 'notify': {
        if (!chatId) return acknowledge();
        await this.cloud.send(chatId, { type: 'text', text: (data as unknown as NotifyPayload).message });
        return acknowledge();
      }

      case 'info': {
        if (!chatId) return acknowledge();
        await this.cloud.send(chatId, { type: 'text', text: this.formatTraceable('ℹ️', data as { title: string; content: string }) });
        return acknowledge();
      }

      case 'warn': {
        if (!chatId) return acknowledge();
        await this.cloud.send(chatId, { type: 'text', text: this.formatTraceable('⚠️', data as { title: string; content: string }) });
        return acknowledge();
      }

      case 'error': {
        if (!chatId) return acknowledge();
        await this.cloud.send(chatId, { type: 'text', text: this.formatTraceable('❌', data as { title: string; content: string }) });
        return acknowledge();
      }

      case 'tool_use': {
        if (!chatId) return acknowledge();
        let state = this.activityStates.get(activityId);
        if (!state) {
          state = {};
          this.activityStates.set(activityId, state);
        }
        if (state.toolActiveStart === undefined) {
          state.toolActiveStart = Date.now();
          if (this.verbose) {
            try {
              await this.cloud.send(chatId, { type: 'text', text: '🔧 行动中...' });
            } catch (err) {
              log.debug('tool_use indicator send failed: %s', err);
            }
          }
        }
        return acknowledge();
      }

      case 'pair_complete': {
        if (this.verbose) {
          const state = this.activityStates.get(activityId);
          if (state?.toolActiveStart !== undefined) {
            delete state.toolActiveStart;
            // Elapsed time available for future use: (Date.now() - start) / 1000
          }
        }
        return acknowledge();
      }

      case 'think_start':
      case 'think_end':
      case 'content_start':
      case 'content_end':
      case 'think_part':
      case 'start':
        return acknowledge();

      default: {
        return acknowledge();
      }
    }
  }

  /** Send the next queued pending item to cloud. */
  private async sendNextPending(item: PendingItem): Promise<void> {
    let message: string;
    switch (item.type) {
      case 'action_request': message = this.formatActionMessage(item.eventPayload as ActionRequestPayload); break;
      case 'question': message = this.formatQuestionMessage(item.eventPayload as QuestionPayload); break;
      case 'sensitive_info_operation': message = this.formatSensitiveInfoMessage(item.eventPayload as SensitiveInfoOperationPayload); break;
    }
    await this.cloud!.send(item.chatId, { type: 'text', text: message });
  }

  /** Resolve a pending request and drive the queue forward. */
  resolvePending(requestId: string, response: XacppResponse): void {
    for (const [key, pq] of this.pendingQueues) {
      if (pq.active?.requestId === requestId) {
        const resolve = pq.active.resolve;
        pq.active = null;
        resolve(response);
        if (pq.queue.length > 0) {
          const next = pq.queue.shift()!;
          pq.active = next;
          this.sendNextPending(next).catch(() => {
            pq.active = null;
            next.resolve(errorResponse('send_failed', 'failed to forward queued event to cloud'));
          });
        } else {
          this.pendingQueues.delete(key);
        }
        return;
      }
    }
  }

  /** Cloud message loop: two-phase consumption (idempotent). */
  async run(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    if (this.closed) {
      this.runPromise = Promise.resolve();
      return this.runPromise;
    }
    this.runPromise = this._run();
    return this.runPromise;
  }

  private async _run(): Promise<void> {
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
            log.debug('Phase1: scanning challenge from text (chatId=%s)', msg.chatId);
            this.establishHandler?.submitChallenge(msg.content.text, msg.chatId);
          }
          // Continue consuming — don't route to session yet
          continue;
        }

        // Phase 2: post-establish — normal activity routing
        if (!this.session) {
          continue;
        }

        const { chatId, senderId } = msg;

        // ── Text messages: parse and dispatch by kind ─────────────────────
        if (msg.content.type === 'text' && msg.fallback) {
          continue;
        }

        if (msg.content.type === 'text') {
          const parsed = parseInput(msg.content.text);
          switch (parsed.kind) {
            case 'new': {
              this.unbindActivity(chatId, senderId);
              if (parsed.prompt) {
                const createResponse = await this.session.requestCommand(genericCommand("new_activity", { title: '' }));
                if (createResponse.kind === 'generic' && createResponse.name === 'activity_ready') {
                  const activityId = (createResponse.data as { activity: string }).activity;
                  this.bindActivity(chatId, senderId, activityId);
                  await this.session.requestCommand(genericCommand("invoke_activity", {
                    activity: activityId,
                    messages: [{ type: 'text', text: parsed.prompt }],
                  }));
                  await this.setTypingIndicatorIfNeeded(chatId, senderId, activityId, msg.id);
                }
              } else {
                await this.session.requestCommand(genericCommand("new_activity", { title: '' }));
              }
              continue;
            }

            case 'compact': {
              let activityId = this.getActivityForUser(chatId, senderId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand(genericCommand("last_activity", {}));
                if (lastResponse.kind === 'generic' && lastResponse.name === 'activity_ready') {
                  activityId = (lastResponse.data as { activity: string }).activity;
                  this.bindActivity(chatId, senderId, activityId);
                } else {
                  await this.cloud.send(chatId, { type: 'text', text: '当前暂无活动中的对话' });
                  continue;
                }
              }
              await this.session.requestCommand(genericCommand("compact_activity", { activity: activityId }));
              continue;
            }

            case 'cancel': {
              let activityId = this.getActivityForUser(chatId, senderId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand(genericCommand("last_activity", {}));
                if (lastResponse.kind === 'generic' && lastResponse.name === 'activity_ready') {
                  activityId = (lastResponse.data as { activity: string }).activity;
                  this.bindActivity(chatId, senderId, activityId);
                } else {
                  await this.cloud.send(chatId, { type: 'text', text: '当前暂无活动中的对话' });
                  continue;
                }
              }
              await this.session.requestCommand(genericCommand("cancel_activity", { activity: activityId }));
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
              // ── Pending response routing (highest priority) ──
              const key = this.targetKey(chatId, senderId);
              const pq = this.pendingQueues.get(key);
              if (pq?.active) {
                const response = this.tryParsePendingResponse(pq.active, parsed.text);
                if (response) {
                  this.resolvePending(pq.active.requestId, response);
                  // c: cancel execution — cancel activity and notify cloud
                  if (parsed.text.trim().toLowerCase() === 'c') {
                    const actId = this.getActivityForUser(chatId, senderId);
                    if (actId) {
                      await this.session.requestCommand(genericCommand("cancel_activity", { activity: actId }));
                      await this.cloud.send(chatId, { type: 'text', text: '✅ 已终止当前任务，可下达新的指令' });
                    }
                  }
                } else {
                  await this.cloud.send(chatId, { type: 'text', text: '⚠️ 无法识别的指令，请按照提示回复' });
                }
                continue;
              }

              // ── Original invoke logic ──
              let activityId = this.getActivityForUser(chatId, senderId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand(genericCommand("last_activity", {}));
                if (lastResponse.kind === 'generic' && lastResponse.name === 'activity_ready') {
                  activityId = (lastResponse.data as { activity: string }).activity;
                } else {
                  const createResponse = await this.session.requestCommand(genericCommand("new_activity", { title: '' }));
                  if (createResponse.kind === 'generic' && createResponse.name === 'activity_ready') {
                    activityId = (createResponse.data as { activity: string }).activity;
                  } else {
                    continue;
                  }
                }
                this.bindActivity(chatId, senderId, activityId);
              }
              const invokeKey = this.targetKey(chatId, senderId);
              const bufferedMedia = this.pendingMediaByTarget.get(invokeKey) ?? [];
              if (bufferedMedia.length > 0) {
                this.pendingMediaByTarget.delete(invokeKey);
              }
              await this.session.requestCommand(genericCommand("invoke_activity", {
                activity: activityId,
                messages: [...bufferedMedia, { type: 'text', text: parsed.text }],
              }));
              await this.setTypingIndicatorIfNeeded(chatId, senderId, activityId, msg.id);
              continue;
            }
          }
        }

        // ── Non-text messages: PlatformClient already resolved localUri ─────
        const part = { ...msg.content } as ContentPart;

        const mediaKey = this.targetKey(chatId, senderId);
        let buffered = this.pendingMediaByTarget.get(mediaKey);
        if (!buffered) {
          buffered = [];
          this.pendingMediaByTarget.set(mediaKey, buffered);
        }
        buffered.push(part);
        log.debug('← cloud recv: %s (chatId=%s, buffered=%d)', msg.content.type, chatId, buffered.length);
      }
    } catch (err) {
      log.error('cloud message loop error: %s', err);
      this.abortCtrl.abort();
    }
  }

  /** Mark the establish handshake as completed — switches to Phase 2 routing. */
  markEstablished(): void {
    this.established = true;
    if (this.cloud && this.sessionChatId) {
      this.cloud.send(this.sessionChatId, { type: 'text', text: '✅ 连接已建立' })
        .catch((err) => log.debug('established notification send failed: %s', err));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.established && this.cloud && this.sessionChatId) {
      await this.cloud.send(this.sessionChatId, { type: 'text', text: '👋 连接已关闭' })
        .catch((err) => log.debug('disconnect notification send failed: %s', err));
    }
    this.abortCtrl.abort();
    this.runPromise = null;
    for (const [, pq] of this.pendingQueues) {
      if (pq.active) {
        pq.active.resolve(errorResponse('cancelled', 'Bridge closing'));
      }
      for (const item of pq.queue) {
        item.resolve(errorResponse('cancelled', 'Bridge closing'));
      }
    }
    this.pendingQueues.clear();
    this.pendingMediaByTarget.clear();
    for (const [activityId, state] of this.activityStates) {
      if (state.processingMessageId !== undefined) {
        const target = this.activityToTarget.get(activityId);
        if (target) {
          await this.cloud?.releaseTypingIndicator(target.chatId, target.senderId, state.processingMessageId).catch(() => {});
        }
      }
    }
    this.activityStates.clear();
    this.chatUserToActivity.clear();
    this.activityToTarget.clear();
    if (this.cloudReadyResolve) {
      this.cloudReadyResolve();
      this.cloudReadyResolve = null;
    }
    await Promise.all([
      this.cloud?.close(),
      this.transport.disconnect(),
    ]);
  }
}

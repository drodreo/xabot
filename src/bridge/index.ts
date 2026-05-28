import type { ChannelId, UserId } from '../core/types.js';
import { StreamCapability } from '../core/types.js';
import type { PlatformClient } from '../core/client.js';
import type { XacppSession, XacppTransport, XacppActivityEvent, XacppCommand, XacppResponse, ContentPart, ActionRequestEvent, QuestionEvent, SensitiveInfoOperationEvent } from 'xacpp';
import { parseInput } from './input-parser.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('Bridge');
import type { MessageId } from '../core/types.js';

interface PendingItem {
  requestId: string;
  type: 'action_request' | 'question' | 'sensitive_info_operation';
  chatId: ChannelId;
  senderId: UserId;
  eventPayload: ActionRequestEvent | QuestionEvent | SensitiveInfoOperationEvent;
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
    eventPayload: ActionRequestEvent | QuestionEvent | SensitiveInfoOperationEvent,
  ): PendingItem {
    return { requestId: eventPayload.requestId, type, chatId, senderId, eventPayload, resolve: () => {} };
  }

  /** Format action_request for cloud display. */
  private formatActionMessage(payload: ActionRequestEvent): string {
    const alertLabel = payload.alert === 'critical' ? '🔴' : payload.alert === 'warn' ? '🟡' : 'ℹ️';
    return [
      `${alertLabel} [Authorization Request] ${payload.intent || payload.description}`,
      `Tool: ${payload.toolName}`,
      payload.arguments ? `Arguments: ${payload.arguments}` : '',
      '───────────────',
      'a: 始终允许 | y: 单次允许',
      'n [原因]: 本次拒绝（可附带拒绝原因）',
      'c: 取消执行',
    ].filter(Boolean).join('\n');
  }

  /** Format question for cloud display. */
  private formatQuestionMessage(payload: QuestionEvent): string {
    const lines = [`❓ [Question] ${payload.question}`];
    if (payload.options.length > 0) {
      lines.push('Options:');
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
  private formatSensitiveInfoMessage(payload: SensitiveInfoOperationEvent): string {
    const lines = [`🔒 [Sensitive Info Operation] ${payload.operation.type}`];
    const items = payload.operation.items;
    lines.push('Items:');
    items.forEach((item, i) => lines.push(`  ${i + 1}. ${item.displayText} (${item.siType})`));
    lines.push('───────────────');
    lines.push('逐行回复值（每行对应一项） | t: 取消执行');
    return lines.join('\n');
  }

  /** Parse user text into a pending response, or null if unrecognized. */
  private tryParsePendingResponse(item: PendingItem, text: string): XacppResponse | null {
    const input = text.trim().toLowerCase();

    switch (item.type) {
      case 'action_request': {
        if (input === 'a') return { kind: 'action', requestId: item.requestId, type: 'approve_always' };
        if (input === 'y') return { kind: 'action', requestId: item.requestId, type: 'approve' };
        if (input === 'n' || input.startsWith('n ')) {
          const reason = text.trim().slice(1).trim() || '用户拒绝';
          return { kind: 'action', requestId: item.requestId, type: 'reject', reason };
        }
        if (input === 'c') return { kind: 'action', requestId: item.requestId, type: 'reject', reason: '用户取消执行' };
        return null;
      }

      case 'question': {
        const payload = item.eventPayload as QuestionEvent;
        if (input === 'c') return { kind: 'question', requestId: item.requestId, type: 'skip', reason: '用户取消执行' };
        if (payload.options.length > 0) {
          const num = parseInt(input, 10);
          if (!isNaN(num) && num >= 1 && num <= payload.options.length) {
            return { kind: 'question', requestId: item.requestId, type: 'answer', content: payload.options[num - 1]! };
          }
        }
        return { kind: 'question', requestId: item.requestId, type: 'answer', content: text.trim() };
      }

      case 'sensitive_info_operation': {
        const siPayload = item.eventPayload as SensitiveInfoOperationEvent;
        if (input === 'c') {
          const results = siPayload.operation.items.map((itm) =>
            siPayload.operation.type === 'collect'
              ? { type: 'collect_skipped' as const, key: itm.key, reason: '用户取消执行' }
              : { type: 'delete_rejected' as const, id: itm.id ?? '', reason: '用户取消执行' }
          );
          return { kind: 'sensitive_info_operation', requestId: item.requestId, results };
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
          return { kind: 'sensitive_info_operation', requestId: item.requestId, results };
        }
        const results = items.map((itm: { id?: string }) => ({ type: 'deleted' as const, id: itm.id ?? '' }));
        return { kind: 'sensitive_info_operation', requestId: item.requestId, results };
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

  /** Handle Command from downstream Agent (forwarded via XabotSessionHandler.onCommand). */
  async handleCommand(command: XacppCommand): Promise<XacppResponse> {
    if (!this.cloud) return { kind: 'acknowledge' };
    if (typeof command === 'object' && 'message' in command) {
      const chatId = this.sessionChatId;
      if (!chatId) return { kind: 'acknowledge' };
      for (const part of command.message.content) {
        await this._sendContentPart(chatId, '' as UserId, '', part);
      }
      return { kind: 'acknowledge' };
    }
    return { kind: 'acknowledge' };
  }

  /** Handle Event from downstream Agent (forwarded via XabotSessionHandler.onEvent). */
  async handleEvent(activityId: string, event: XacppActivityEvent): Promise<XacppResponse> {
    if (!this.cloud) return { kind: 'acknowledge' };
    const target = this.activityToTarget.get(activityId);
    if (!target) return { kind: 'acknowledge' };
    const { chatId } = target;

    // Non-think events end the thinking phase
    if (event.event.type !== 'think') {
      const state = this.activityStates.get(activityId);
      if (state?.thinkingStart) {
        await this.endThinking(chatId, activityId);
      }
    }

    // Non-content_delta events clear expressing phase
    if (event.event.type !== 'content_delta') {
      const state = this.activityStates.get(activityId);
      if (state?.expressingStart !== undefined) {
        delete state.expressingStart;
      }
    }

    // Handle typing indicator: refresh for non-complete, release for complete
    if (event.event.type === 'complete') {
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

    switch (event.event.type) {
      case 'think': {
        if (!chatId) return { kind: 'acknowledge' };
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
        return { kind: 'acknowledge' };
      }

      case 'content_delta': {
        if (!chatId) return { kind: 'acknowledge' };
        // content_delta is only emitted in streaming mode — forward only on streaming platforms
        if (this.cloud!.streamCapability() === StreamCapability.NonStreaming) {
          return { kind: 'acknowledge' };
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
        const payload = event.event.payload as ContentPart;
        await this._sendContentPart(chatId, target.senderId, activityId, payload);
        return { kind: 'acknowledge' };
      }

      case 'content_part': {
        if (!chatId) return { kind: 'acknowledge' };
        // content_part is emitted in non-streaming mode — forward only if verbose
        if (this.verbose) {
          const payload = event.event.payload as ContentPart;
          await this._sendContentPart(chatId, target.senderId, activityId, payload);
        }
        return { kind: 'acknowledge' };
      }

      case 'tool_result': {
        if (!chatId) return { kind: 'acknowledge' };
        const payload = event.event;
        if (payload.toolName === 'send_message') {
          for (const part of payload.parts) {
            await this._sendContentPart(chatId, target.senderId, activityId, part);
          }
        }
        return { kind: 'acknowledge' };
      }

      case 'complete': {
        const payload = event.event;
        for (const part of payload.assistantReply) {
          await this._sendContentPart(chatId, target.senderId, activityId, part);
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
        const key = this.targetKey(chatId, target.senderId);
        const pq = this.ensureQueue(key);
        const item = this.createPendingItem(chatId, target.senderId, 'action_request', event.event);
        const pendingPromise = new Promise<XacppResponse>((resolve) => { item.resolve = resolve; });
        if (!pq.active) {
          pq.active = item;
          try {
            await this.cloud.send(chatId, { type: 'text', text: this.formatActionMessage(event.event) });
          } catch {
            pq.active = null;
            item.resolve({ kind: 'error', code: 'send_failed', message: 'failed to forward action_request to cloud' });
          }
        } else {
          pq.queue.push(item);
        }
        return pendingPromise;
      }

      case 'question': {
        if (!chatId) return { kind: 'acknowledge' };
        const key = this.targetKey(chatId, target.senderId);
        const pq = this.ensureQueue(key);
        const item = this.createPendingItem(chatId, target.senderId, 'question', event.event);
        const pendingPromise = new Promise<XacppResponse>((resolve) => { item.resolve = resolve; });
        if (!pq.active) {
          pq.active = item;
          try {
            await this.cloud.send(chatId, { type: 'text', text: this.formatQuestionMessage(event.event) });
          } catch {
            pq.active = null;
            item.resolve({ kind: 'error', code: 'send_failed', message: 'failed to forward question to cloud' });
          }
        } else {
          pq.queue.push(item);
        }
        return pendingPromise;
      }

      case 'sensitive_info_operation': {
        if (!chatId) return { kind: 'acknowledge' };
        const key = this.targetKey(chatId, target.senderId);
        const pq = this.ensureQueue(key);
        const item = this.createPendingItem(chatId, target.senderId, 'sensitive_info_operation', event.event);
        const pendingPromise = new Promise<XacppResponse>((resolve) => { item.resolve = resolve; });
        if (!pq.active) {
          pq.active = item;
          try {
            await this.cloud.send(chatId, { type: 'text', text: this.formatSensitiveInfoMessage(event.event) });
          } catch {
            pq.active = null;
            item.resolve({ kind: 'error', code: 'send_failed', message: 'failed to forward sensitive_info_operation to cloud' });
          }
        } else {
          pq.queue.push(item);
        }
        return pendingPromise;
      }

      case 'info': {
        if (!chatId) return { kind: 'acknowledge' };
        await this.cloud.send(chatId, { type: 'text', text: `ℹ️ ${event.event.content}` });
        return { kind: 'acknowledge' };
      }

      case 'warn': {
        if (!chatId) return { kind: 'acknowledge' };
        await this.cloud.send(chatId, { type: 'text', text: `⚠️ ${event.event.content}` });
        return { kind: 'acknowledge' };
      }

      case 'error': {
        if (!chatId) return { kind: 'acknowledge' };
        await this.cloud.send(chatId, { type: 'text', text: `❌ ${event.event.content}` });
        return { kind: 'acknowledge' };
      }

      case 'tool_use': {
        if (!chatId) return { kind: 'acknowledge' };
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
        return { kind: 'acknowledge' };
      }

      case 'pair_complete': {
        if (this.verbose) {
          const state = this.activityStates.get(activityId);
          if (state?.toolActiveStart !== undefined) {
            delete state.toolActiveStart;
            // Elapsed time available for future use: (Date.now() - start) / 1000
          }
        }
        return { kind: 'acknowledge' };
      }

      default: {
        return { kind: 'acknowledge' };
      }
    }
  }

  /** Send the next queued pending item to cloud. */
  private async sendNextPending(item: PendingItem): Promise<void> {
    let message: string;
    switch (item.type) {
      case 'action_request': message = this.formatActionMessage(item.eventPayload as ActionRequestEvent); break;
      case 'question': message = this.formatQuestionMessage(item.eventPayload as QuestionEvent); break;
      case 'sensitive_info_operation': message = this.formatSensitiveInfoMessage(item.eventPayload as SensitiveInfoOperationEvent); break;
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
            next.resolve({ kind: 'error', code: 'send_failed', message: 'failed to forward queued event to cloud' });
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
          const mediaKey = this.targetKey(chatId, senderId);
          let buffered = this.pendingMediaByTarget.get(mediaKey);
          if (!buffered) {
            buffered = [];
            this.pendingMediaByTarget.set(mediaKey, buffered);
          }
          buffered.push({ ...msg.content });
          log.debug('← cloud recv: fallback (chatId=%s, buffered=%d)', chatId, buffered.length);
          continue;
        }

        if (msg.content.type === 'text') {
          const parsed = parseInput(msg.content.text);
          switch (parsed.kind) {
            case 'new': {
              this.unbindActivity(chatId, senderId);
              const createResponse = await this.session.requestCommand({
                new_activity: { title: '' },
              });
              if (createResponse.kind === 'activity_ready') {
                const newActivityId = createResponse.activity;
                this.bindActivity(chatId, senderId, newActivityId);
                if (parsed.prompt) {
                  await this.session.requestCommand({
                    invoke_activity: {
                      activity: newActivityId,
                      messages: [{ type: 'text', text: parsed.prompt }],
                    },
                  });
                  await this.setTypingIndicatorIfNeeded(chatId, senderId, newActivityId, msg.id);
                }
              }
              continue;
            }

            case 'compact': {
              let activityId = this.getActivityForUser(chatId, senderId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand('last_activity');
                if (lastResponse.kind === 'activity_ready') {
                  activityId = lastResponse.activity;
                  this.bindActivity(chatId, senderId, activityId);
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
              let activityId = this.getActivityForUser(chatId, senderId);
              if (!activityId) {
                const lastResponse = await this.session.requestCommand('last_activity');
                if (lastResponse.kind === 'activity_ready') {
                  activityId = lastResponse.activity;
                  this.bindActivity(chatId, senderId, activityId);
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
                      await this.session.requestCommand({ cancel_activity: { activity: actId } });
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
                this.bindActivity(chatId, senderId, activityId);
              }
              const invokeKey = this.targetKey(chatId, senderId);
              const bufferedMedia = this.pendingMediaByTarget.get(invokeKey) ?? [];
              if (bufferedMedia.length > 0) {
                this.pendingMediaByTarget.delete(invokeKey);
              }
              await this.session.requestCommand({
                invoke_activity: {
                  activity: activityId,
                  messages: [...bufferedMedia, { type: 'text', text: parsed.text }],
                },
              });
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
        pq.active.resolve({ kind: 'error', code: 'cancelled', message: 'Bridge closing' });
      }
      for (const item of pq.queue) {
        item.resolve({ kind: 'error', code: 'cancelled', message: 'Bridge closing' });
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

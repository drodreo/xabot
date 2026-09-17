import type { ChannelId, UserId, MessageContent } from '../core/types.js';
import { StreamCapability } from '../core/types.js';
import type { PlatformClient } from '../core/client.js';
import type { XacppSession, XacppTransport, XacppActivityEvent, XacppCommand, XacppResponse, ContentPart, FileRef, ActionRequestPayload, QuestionPayload, NotifyPayload } from 'xacpp';
import { acknowledge, genericResponse, errorResponse, genericCommand, commandName } from 'xacpp';
import { parseInput } from './input-parser.js';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { i18nResource } from '../i18n/index.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('Bridge');
import type { MessageId } from '../core/types.js';

/** Executable/installer extension blacklist for report_to_user interception (case-insensitive). */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk',
  '.bat', '.cmd', '.sh', '.ps1',
]);
/** Executable mimeType prefixes for report_to_user interception. */
const EXECUTABLE_MIME_PREFIXES = [
  'application/x-executable',
  'application/x-msdownload',
  'application/vnd.android.package-archive',
];

/** 扩展名 → MIME 推导表（归一化层内部职责，模型不参与）。 */
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
};

function mimeFromExt(value: string): string {
  const ext = extname(value.split('?')[0] ?? '').toLowerCase();
  return EXT_MIME[ext] ?? '';
}

/** 路径/URL → FileRef：http(s) 按 remoteUrl，其余按本机路径（sizeBytes 由 fs 补齐，读不到不阻塞投递）。 */
async function fileRefFromValue(value: string): Promise<FileRef> {
  if (/^https?:\/\//.test(value)) {
    return { remoteUrl: value, localUri: '', mimeType: mimeFromExt(value), sizeBytes: 0 };
  }
  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(value)).size;
  } catch {
    log.warn('normalize: 文件不可读，sizeBytes 置 0: %s', value);
  }
  return { remoteUrl: '', localUri: value, mimeType: mimeFromExt(value), sizeBytes };
}

/**
 * 分片归一化（投递管线前段的唯一入口）：
 * - 简化形态 `{ text }` / `{ image|audio|video|file: 本机绝对路径 }`（report_to_user 声明形态）→ ContentPart
 * - 已是 ContentPart 形态的（deliver 流量）原样通过
 * - 无法识别的原样放行，由投递侧兜底为占位文本
 */
async function normalizePart(item: unknown): Promise<ContentPart> {
  if (typeof item !== 'object' || item === null) return item as ContentPart;
  const p = item as { type?: unknown; text?: unknown; image?: unknown; audio?: unknown; video?: unknown; file?: unknown };
  if (typeof p.type === 'string') return item as ContentPart;
  if (typeof p.text === 'string') return { type: 'text', text: p.text };
  for (const kind of ['image', 'audio', 'video', 'file'] as const) {
    const v = p[kind];
    if (typeof v === 'string') {
      const source = await fileRefFromValue(v);
      if (kind === 'file') return { type: 'file', source, name: basename(v.split('?')[0] ?? v) } as ContentPart;
      return { type: kind, source } as ContentPart;
    }
  }
  return item as ContentPart;
}

interface PendingItem {
  type: 'action_request' | 'question';
  chatId: ChannelId;
  senderId: UserId;
  eventPayload: ActionRequestPayload | QuestionPayload;
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

  /** Max report_to_user calls allowed per round. */
  private static readonly REPORT_MAX_CALLS_PER_ROUND = 5;
  /**
   * activityId (envelope activity.id) → message-pipeline deliveries in the
   * current round. Deliveries without an envelope activity share the '' bucket
   * (governance has no exemptions). Reset to zero per activity on each xacpp
   * start event (new round).
   */
  private readonly reportCallCounts = new Map<string, number>();

  /**
   * Buckets (envelope activity.id) with a successful report_to_user delivery
   * in the current round. Same lifecycle as reportCallCounts: cleared per
   * activity on each xacpp start event (new round). A matching bucket
   * suppresses the complete event's assistantReply (round already delivered
   * via report_to_user).
   */
  private readonly reportedBuckets = new Set<string>();

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
    type: 'action_request' | 'question',
    eventPayload: ActionRequestPayload | QuestionPayload,
  ): PendingItem {
    return { type, chatId, senderId, eventPayload, resolve: () => {} };
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
        if (input === 'a') return genericResponse("action", { type: 'approve_always' });
        if (input === 'y') return genericResponse("action", { type: 'approve' });
        if (input === 'c') return genericResponse("action", { type: 'reject', reason: '用户取消执行' });
        return genericResponse("action", { type: 'reject', reason: text.trim() });
      }

      case 'question': {
        const payload = item.eventPayload as QuestionPayload;
        if (input === 'c') return genericResponse("question", { type: 'skip', reason: '用户取消执行' });
        if (payload.options.length > 0) {
          const num = parseInt(input, 10);
          if (!isNaN(num) && num >= 1 && num <= payload.options.length) {
            return genericResponse("question", { type: 'answer', content: payload.options[num - 1]! });
          }
        }
        return genericResponse("question", { type: 'answer', content: text.trim() });
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
    // wire 数据不可信：缺 type 但带 text 的分片按文本处理（模型可能漏 type 字段）
    if (part.type === 'text' || (part.type === undefined && typeof (part as { text?: unknown }).text === 'string')) {
      log.debug('→ cloud send: text (chatId=%s)', chatId);
      await this.cloud.send(chatId, { type: 'text', text: (part as { text: string }).text });
    } else {
      const src = part.source;
      if (src && (src.localUri || src.remoteUrl)) {
        log.info('→ cloud send: %s (chatId=%s)', part.type, chatId);
        const name = (part as { name?: string }).name;
        await this.cloud.send(chatId, { type: part.type, source: src, ...(name !== undefined ? { name } : {}) });
      } else {
        log.warn('→ cloud send: %s fallback to text — no source (chatId=%s)', part.type, chatId);
        await this.cloud.send(chatId, { type: 'text', text: `[${part.type ?? 'unknown'}]` });
      }
    }
  }

  /** Route interaction command to pending queue. Shared by handleCommand for action_request/question. */
  private async _handleInteractionCommand(
    type: 'action_request' | 'question',
    payload: ActionRequestPayload | QuestionPayload,
    activityId: string | undefined,
  ): Promise<XacppResponse> {
    if (!this.cloud) return acknowledge();

    // Look up target from the envelope activity (source of the command)
    const target = activityId ? this.activityToTarget.get(activityId) : undefined;
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

    if (typeof command === 'object' && 'generic' in command) {
      const activityId = command.generic.activity?.id;

      // message: wire-level delivery command (receiver side of deliver /
      // report_to_user underlying transports) — governed by the message pipeline.
      if (name === 'message') {
        return this._deliverViaMessagePipeline(command.generic.arguments as { content: unknown[] }, activityId, 'message');
      }

      // report_to_user: agent submits the round report (contract: one call = one logical message) —
      // delegates to the message pipeline so governance applies without exemptions.
      if (name === 'report_to_user') {
        return this._deliverViaMessagePipeline(command.generic.arguments as { content: unknown[] }, activityId, 'report_to_user');
      }

      // Interaction commands (moved from Event to Command in xacpp 0.7.x)
      const args = command.generic.arguments as Record<string, unknown>;
      switch (name) {
        case 'action_request':
          return this._handleInteractionCommand('action_request', args as unknown as ActionRequestPayload, activityId);
        case 'question':
          return this._handleInteractionCommand('question', args as unknown as QuestionPayload, activityId);
      }
    }

    return acknowledge();
  }

  /**
   * message 投递管线：治理（activity 分桶计数、投递上限、余额反馈、可执行拦截）
   * + 平台投递。message（含 deliver 流量）与 report_to_user 统一走此管线，
   * 凡基于 message 的投递一致受治理，无豁免。WeChat aggregates all parts
   * into a single physical message; other platforms send per part (message
   * model limit, allowed by contract). Success response carries the remaining
   * count. 治理分桶键为信封 activity.id；无信封 activity 的流量共享 ''
   * 兜底桶，同样受限。
   */
  private async _deliverViaMessagePipeline(
    args: { content: unknown[] },
    activityId: string | undefined,
    responderName: 'message' | 'report_to_user',
  ): Promise<XacppResponse> {
    if (!this.cloud) {
      // S4: 报告类内容静默丢弃后果重于普通命令——返回错误让模型感知未送达
      return errorResponse('report_delivery_failed', '报告通道未就绪（平台客户端未连接），报告未送达');
    }
    const chatId = this.sessionChatId;
    if (!chatId) {
      return errorResponse('report_delivery_failed', '报告通道未就绪（会话未绑定聊天），报告未送达');
    }

    const bucket = activityId ?? '';
    const used = this.reportCallCounts.get(bucket) ?? 0;
    if (used >= Bridge.REPORT_MAX_CALLS_PER_ROUND) {
      return errorResponse('report_limit_reached', '到下一次用户输入前的报告次数已用完（5 次），请勿继续调用');
    }

    const normalized = await Promise.all((args.content ?? []).map((item) => normalizePart(item)));
    const parts = this._interceptExecutableParts(normalized);
    if (this.cloud.platform === 'wechat') {
      // One call = one logical message: aggregated single physical send
      const aggregated = this.cloud as PlatformClient & {
        sendAggregated?: (chatId: ChannelId, parts: MessageContent[]) => Promise<MessageId>;
      };
      if (typeof aggregated.sendAggregated === 'function') {
        await aggregated.sendAggregated(chatId, parts as MessageContent[]);
      } else {
        for (const part of parts) {
          await this._sendContentPart(chatId, '' as UserId, '', part);
        }
      }
    } else {
      for (const part of parts) {
        await this._sendContentPart(chatId, '' as UserId, '', part);
      }
    }

    this.reportCallCounts.set(bucket, used + 1);
    if (responderName === 'report_to_user') {
      this.reportedBuckets.add(bucket);
    }
    const remaining = Bridge.REPORT_MAX_CALLS_PER_ROUND - (used + 1);
    return genericResponse(responderName, { remaining, message: `内容已投递，到下一次用户输入前你还可以报告 ${remaining} 次` });
  }

  /** Replace file parts hitting the executable blacklist with text placeholders; originals are never read or forwarded. Missing wire fields are treated as non-blocking. */
  private _interceptExecutableParts(parts: ContentPart[]): ContentPart[] {
    return parts.map((part) => {
      if (part.type !== 'file') return part;
      const src = part.source as Partial<FileRef> | undefined;
      const name = (part as { name?: string }).name
        || src?.localUri?.split('/').pop()
        || src?.remoteUrl?.split('/').pop()
        || 'unknown';
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      const mimeType = typeof src?.mimeType === 'string' ? src.mimeType.toLowerCase() : '';
      const blocked = EXECUTABLE_EXTENSIONS.has(ext)
        || EXECUTABLE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
      if (!blocked) return part;
      return { type: 'text', text: `[已拦截可执行文件：${name}，该类型文件不支持转发]` } as ContentPart;
    });
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
        if (this.reportedBuckets.has(activityId)) {
          log.debug('complete assistantReply suppressed: report_to_user already delivered this round (activity %s)', activityId);
          return acknowledge();
        }
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

      case 'start': {
        // xacpp start = new round: reset the message-pipeline delivery count
        // for this activity (bucket key = envelope activity.id, same as the
        // delivery counter)
        this.reportCallCounts.delete(activityId);
        this.reportedBuckets.delete(activityId);
        return acknowledge();
      }

      case 'think_start':
      case 'think_end':
      case 'content_start':
      case 'content_end':
      case 'think_part':
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
    }
    await this.cloud!.send(item.chatId, { type: 'text', text: message });
  }

  /** Resolve the active pending item of the target queue (by targetKey) and drive the queue forward. */
  resolvePending(key: string, response: XacppResponse): void {
    const pq = this.pendingQueues.get(key);
    if (!pq?.active) return;
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
                  this.resolvePending(key, response);
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

import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler, ContentPart, XacppEvent, XacppSession } from 'xacpp';
import { acknowledge, genericResponse, genericCommand, commandName, newEvent } from 'xacpp';
import { StdinRouter } from './stdin-router.js';
import { createLogger } from '../core/logger.js';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
const log = createLogger('chat-handler');

type MediaKind = 'image' | 'audio' | 'video' | 'file';

type ParsedInput =
  | { kind: 'text'; text?: string }
  | { kind: 'media'; mediaKind?: MediaKind; filePath?: string }
  | { kind: 'complete'; text?: string }
  | { kind: 'action'; toolName: string; description: string }
  | { kind: 'question'; question: string; options?: string[] };

function parseTerminalInput(input: string): ParsedInput {
  if (input.startsWith('/image ')) return { kind: 'media', mediaKind: 'image', filePath: input.slice(7).trim() };
  if (input.startsWith('/audio ')) return { kind: 'media', mediaKind: 'audio', filePath: input.slice(7).trim() };
  if (input.startsWith('/video ')) return { kind: 'media', mediaKind: 'video', filePath: input.slice(7).trim() };
  if (input.startsWith('/file '))  return { kind: 'media', mediaKind: 'file',  filePath: input.slice(6).trim() };
  if (input === '/complete')       return { kind: 'complete' };
  if (input.startsWith('/complete ')) return { kind: 'complete', text: input.slice(10).trim() };
  if (input.startsWith('/action ')) {
    const rest = input.slice(8).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      return { kind: 'action', toolName: rest, description: rest };
    }
    return { kind: 'action', toolName: rest.slice(0, spaceIdx), description: rest.slice(spaceIdx + 1).trim() };
  }
  if (input.startsWith('/question ')) {
    const rest = input.slice(10).trim();
    const sepIdx = rest.indexOf('|');
    if (sepIdx === -1) {
      return { kind: 'question', question: rest };
    }
    const question = rest.slice(0, sepIdx).trim();
    const options = rest.slice(sepIdx + 1).split('|').map(s => s.trim()).filter(Boolean);
    return { kind: 'question', question, options };
  }
  return { kind: 'text', text: input };
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
};

function fileToContentPart(kind: MediaKind, filePath: string): ContentPart {
  const abs = resolve(filePath);
  const stat = statSync(abs);
  const ext = abs.substring(abs.lastIndexOf('.')).toLowerCase();
  const mimeType = EXT_MIME[ext] ?? 'application/octet-stream';
  const source: import('xacpp').FileRef = { localUri: abs, remoteUrl: '', mimeType, sizeBytes: stat.size };
  return { type: kind, source } as ContentPart;
}

/**
 * Initiator-side XacppSessionHandler for the `chat` CLI subcommand.
 *
 * Data flow:
 *   - **onCommand**: receives `new_activity` / `invoke_activity` / `last_activity` from the Responder.
 *     Prints incoming messages to the terminal. For `last_activity`, prompts the user via stdin.
 *   - **onEvent**: returns acknowledge (the Initiator does not receive events from the Responder;
 *     it sends events via `sendReply()` to push agent replies back).
 *   - **sendReply**: sends a `message` command to the Responder, which routes it through
 *     Bridge → cloud.send() → Feishu/WeChat.
 */
export class InitiatorSessionHandler implements XacppSessionHandler {
  private readonly router: StdinRouter;
  private activityId: string | null = null;
  private cmdResolve: ((value: string) => void) | null = null;

  constructor(router: StdinRouter) {
    this.router = router;
    this.router.subscribe('cmd_response', (input) => {
      this.cmdResolve?.(input);
      this.cmdResolve = null;
    });
  }

  async onCommand(command: XacppCommand): Promise<XacppResponse> {
    const name = commandName(command);

    if (name === 'new_activity') {
      // Responder requests a new activity — generate an ID.
      this.activityId = crypto.randomUUID();
      log.info('activity created: %s', this.activityId);
      log.info('new_activity → activity_ready, agent=chat');
      return genericResponse("activity_ready", { activity: this.activityId, agent: 'chat' });
    }

    if (name === 'invoke_activity') {
      // Responder forwards a cloud message — print it to terminal.
      const args = (command as { generic: { arguments: { messages: ContentPart[] } } }).generic.arguments;
      const { messages } = args;
      for (const part of messages) {
        if (part.type === 'text') {
          log.info('invoke_activity [act-%s][> IN]: %s', this.activityId ?? 'none', part.text);
        } else {
          const src = part.source;
          const location = src.localUri || src.remoteUrl;
          log.info('invoke_activity [act-%s][> IN]: [%s: %s] mime=%s', this.activityId ?? 'none', part.type, location, src.mimeType || 'unknown');
        }
      }
      return acknowledge();
    }

    if (name === 'compact_activity') {
      const args = (command as { generic: { arguments: { activity: string } } }).generic.arguments;
      log.info('compact_activity [act-%s]', args.activity);
      return acknowledge();
    }

    if (name === 'cancel_activity') {
      const args = (command as { generic: { arguments: { activity: string } } }).generic.arguments;
      log.info('cancel_activity [act-%s]', args.activity);
      return acknowledge();
    }

    if (name === 'last_activity') {
      log.info('received last_activity command');
      log.info('last_activity → received');
      this.router.intercept();
      log.info('Resume previous activity? Enter activity ID (or press Enter for new):');

      const input = await new Promise<string>((resolve) => {
        this.cmdResolve = resolve;
      });

      this.router.release();

      if (!input) {
        log.info('no activity ID provided, returning activity_not_found');
        log.info('last_activity → activity_not_found');
        return genericResponse("activity_not_found", null);
      }
      this.activityId = input;
      log.info('resuming activity: %s', input);
      log.info('last_activity → activity_ready, agent=chat');
      return genericResponse("activity_ready", { activity: input, agent: 'chat' });
    }

    log.warn('unknown command: %s → acknowledge', name);
    return acknowledge();
  }

  async onEvent(_event: XacppActivityEvent): Promise<XacppResponse> {
    // Initiator does not receive events — it sends them via sendReply().
    return acknowledge();
  }

  private async sendEvent(session: XacppSession, event: XacppEvent): Promise<XacppResponse> {
    if (!this.activityId) return acknowledge();
    return session.requestEvent({ activity: this.activityId, event });
  }

  /**
   * Send a reply from the terminal user to the Responder,
   * routing text/media through Bridge → cloud.send(),
   * or simulating an Agent completion via /complete.
   */
  async sendReply(session: XacppSession, text: string): Promise<void> {
    const parsed = parseTerminalInput(text);

    // ── /complete: simulate invoke completion ─────────────────────────
    if (parsed.kind === 'complete') {
      const assistantReply: ContentPart[] = [];
      if (parsed.text) assistantReply.push({ type: 'text', text: parsed.text });
      log.info('complete [act-%s]', this.activityId ?? 'none');
      if (this.activityId) {
        await this.sendEvent(session, newEvent('complete', { assistantReply }));
      } else {
        // No activity — fall back to message command
        if (parsed.text) {
          await session.requestCommand(genericCommand("message", { content: [{ type: 'text', text: parsed.text }] }));
        }
      }
      return;
    }

    // ── /action: simulate action_request command ──
    if (parsed.kind === 'action') {
      if (!this.activityId) {
        log.warn('no active activity, ignoring /action');
        return;
      }
      const requestId = crypto.randomUUID();
      log.info('action_request [act-%s] tool=%s desc=%s', this.activityId, parsed.toolName, parsed.description);
      const response = await session.requestCommand(genericCommand("action_request", {
        activity: this.activityId,
        requestId,
        toolName: parsed.toolName,
        arguments: '',
        actionId: crypto.randomUUID(),
        description: parsed.description,
        alert: 'info',
        intent: parsed.description,
      }));
      if (response.kind === 'generic' && response.name === 'action') {
        const data = response.data as { requestId: string; type: string; reason?: string };
        log.info('action_response [act-%s] req=%s result=%s%s', this.activityId, data.requestId, data.type,
          data.type === 'reject' ? ` reason=${data.reason}` : '');
      } else {
        log.info('action_response [act-%s] %s', this.activityId ?? 'none', response.kind);
      }
      return;
    }

    // ── /question: simulate question command ──
    if (parsed.kind === 'question') {
      if (!this.activityId) {
        log.warn('no active activity, ignoring /question');
        return;
      }
      const requestId = crypto.randomUUID();
      log.info('question [act-%s] q=%s options=%s', this.activityId, parsed.question, parsed.options?.join(',') ?? '');
      const response = await session.requestCommand(genericCommand("question", {
        activity: this.activityId,
        requestId,
        question: parsed.question,
        options: parsed.options ?? [],
      }));
      if (response.kind === 'generic' && response.name === 'question') {
        const data = response.data as { requestId: string; type: string; content?: string };
        log.info('question_response [act-%s] req=%s type=%s content=%s',
            this.activityId, data.requestId, data.type,
            data.type === 'answer' ? data.content : '(skip)');
      } else {
        log.info('question_response [act-%s] %s', this.activityId ?? 'none', response.kind);
      }
      return;
    }

    // ── Build ContentPart ─────────────────────────────────────────────
    let part: ContentPart;
    if (parsed.kind === 'media') {
      part = fileToContentPart(parsed.mediaKind!, parsed.filePath!);
      log.info('%s: %s (%d bytes)', parsed.mediaKind, parsed.filePath, (part as any).source.sizeBytes);
    } else {
      part = { type: 'text', text: parsed.text! };
      log.info('invoke_activity [act-%s][> OUT]: %s', this.activityId ?? 'none', parsed.text);
    }

    // ── Send ──────────────────────────────────────────────────────────
    if (this.activityId) {
      // Scenario 2: has activity → requestEvent
      await this.sendEvent(session, newEvent('content_part', { round: '', pair: '', payload: part }));
    } else {
      // Scenario 1: no activity → message command
      await session.requestCommand(genericCommand("message", { content: [part] }));
    }
  }
}

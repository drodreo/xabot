import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler, ContentPart } from 'xacpp';
import type { XacppSession } from 'xacpp';
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
    if (typeof command === 'object' && 'new_activity' in command) {
      // Responder requests a new activity — generate an ID.
      this.activityId = crypto.randomUUID();
      log.info('activity created: %s', this.activityId);
      log.info('new_activity → activity_ready, agent=chat');
      return { kind: 'activity_ready', activity: this.activityId, agent: 'chat' };
    }

    if (typeof command === 'object' && 'invoke_activity' in command) {
      // Responder forwards a cloud message — print it to terminal.
      const { messages } = command.invoke_activity;
      for (const part of messages) {
        if (part.type === 'text') {
          log.info('invoke_activity [act-%s][> IN]: %s', this.activityId ?? 'none', part.text);
        } else if (part.type === 'image') {
          log.info('invoke_activity [act-%s][> IN]: [image: %s]', this.activityId ?? 'none', part.source.remoteUrl);
        } else {
          log.info('invoke_activity [act-%s][> IN]: [%s]', this.activityId ?? 'none', part.type);
        }
      }
      return { kind: 'acknowledge' };
    }

    if (typeof command === 'object' && 'compact_activity' in command) {
      const { activity } = command.compact_activity;
      log.info('compact_activity [act-%s]', activity);
      return { kind: 'acknowledge' };
    }

    if (typeof command === 'object' && 'cancel_activity' in command) {
      const { activity } = command.cancel_activity;
      log.info('cancel_activity [act-%s]', activity);
      return { kind: 'acknowledge' };
    }

    if (command === 'last_activity') {
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
        return { kind: 'activity_not_found' };
      }
      this.activityId = input;
      log.info('resuming activity: %s', input);
      log.info('last_activity → activity_ready, agent=chat');
      return { kind: 'activity_ready', activity: input, agent: 'chat' };
    }

    const cmdStr = typeof command === 'string' ? command : (Object.keys(command)[0] ?? 'object');
    log.warn('unknown command: %s → acknowledge', cmdStr);
    return { kind: 'acknowledge' };
  }

  async onEvent(_event: XacppActivityEvent): Promise<XacppResponse> {
    // Initiator does not receive events — it sends them via sendReply().
    return { kind: 'acknowledge' };
  }

  private async sendEvent(session: XacppSession, event: import('xacpp').XacppEvent): Promise<XacppResponse> {
    if (!this.activityId) return { kind: 'acknowledge' };
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
        await this.sendEvent(session, { type: 'complete', assistantReply });
      } else {
        // No activity — fall back to message command
        if (parsed.text) {
          await session.requestCommand({ message: { content: [{ type: 'text', text: parsed.text }] } });
        }
      }
      return;
    }

    // ── /action: simulate action_request event ──
    if (parsed.kind === 'action') {
      if (!this.activityId) {
        log.warn('no active activity, ignoring /action');
        return;
      }
      const requestId = crypto.randomUUID();
      log.info('action_request [act-%s] tool=%s desc=%s', this.activityId, parsed.toolName, parsed.description);
      const response = await this.sendEvent(session, {
        type: 'action_request',
        requestId,
        toolName: parsed.toolName,
        arguments: '',
        actionId: crypto.randomUUID(),
        description: parsed.description,
        alert: 'info',
      });
      if (response.kind === 'action') {
        log.info('action_response [act-%s] req=%s result=%s%s', this.activityId, response.requestId, response.type,
          response.type === 'reject' ? ` reason=${response.reason}` : '');
      } else {
        log.info('action_response [act-%s] %s', this.activityId ?? 'none', response.kind);
      }
      return;
    }

    // ── /question: simulate question event ──
    if (parsed.kind === 'question') {
      if (!this.activityId) {
        log.warn('no active activity, ignoring /question');
        return;
      }
      const requestId = crypto.randomUUID();
      log.info('question [act-%s] q=%s options=%s', this.activityId, parsed.question, parsed.options?.join(',') ?? '');
      const response = await this.sendEvent(session, {
        type: 'question',
        requestId,
        question: parsed.question,
        options: parsed.options ?? [],
      });
      if (response.kind === 'question') {
        log.info('question_response [act-%s] req=%s type=%s content=%s',
            this.activityId, response.requestId, response.type,
            response.type === 'answer' ? response.content : '(skip)');
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
      await this.sendEvent(session, { type: 'content_part', round: '', pair: '', payload: part });
    } else {
      // Scenario 1: no activity → message command
      await session.requestCommand({ message: { content: [part] } });
    }
  }
}

import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler, ContentPart } from 'xacpp';
import type { XacppSession } from 'xacpp';
import { StdinRouter } from './stdin-router.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('chat-handler');

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

  /**
   * Send a text reply from the terminal user to the Responder,
   * which routes it through Bridge → cloud.send() → Feishu/WeChat.
   */
  async sendReply(session: XacppSession, text: string): Promise<void> {
    log.info('invoke_activity [act-%s][> OUT]: %s', this.activityId ?? 'none', text);

    const contentPart: ContentPart = { type: 'text', text };

    await session.requestCommand({
      message: { content: [contentPart] },
    });
  }
}

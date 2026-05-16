import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler, ContentPart } from 'xacpp';
import type { XacppSession } from 'xacpp';
import { StdinRouter } from './stdin-router.js';

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
  private readonly writer: (text: string) => void;
  private readonly router: StdinRouter;
  private activityId: string | null = null;
  private cmdResolve: ((value: string) => void) | null = null;

  constructor(writer: (text: string) => void, router: StdinRouter) {
    this.writer = writer;
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
      this.writer(`[chat] activity created: ${this.activityId}\n`);
      return { kind: 'activity_ready', activity: this.activityId, agent: 'chat' };
    }

    if (typeof command === 'object' && 'invoke_activity' in command) {
      // Responder forwards a cloud message — print it to terminal.
      const { messages } = command.invoke_activity;
      for (const part of messages) {
        if (part.type === 'text') {
          this.writer(`\n[收到] ${part.text}\n`);
        } else if (part.type === 'image') {
          this.writer(`\n[收到] [image: ${part.source.remoteUrl}]\n`);
        } else {
          this.writer(`\n[收到] [${part.type}]\n`);
        }
      }
      return { kind: 'acknowledge' };
    }

    if (command === 'last_activity') {
      this.writer('[chat] received last_activity command\n');
      this.router.intercept();
      this.writer('[chat] Resume previous activity? Enter activity ID (or press Enter for new):\n');

      const input = await new Promise<string>((resolve) => {
        this.cmdResolve = resolve;
      });

      this.router.release();

      if (!input) {
        this.writer('[chat] no activity ID provided, returning activity_not_found\n');
        return { kind: 'activity_not_found' };
      }
      this.activityId = input;
      this.writer(`[chat] resuming activity: ${input}\n`);
      return { kind: 'activity_ready', activity: input, agent: 'chat' };
    }

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
    this.writer(`[发送] ${text}\n`);

    const contentPart: ContentPart = { type: 'text', text };

    await session.requestCommand({
      message: { content: [contentPart] },
    });
  }
}

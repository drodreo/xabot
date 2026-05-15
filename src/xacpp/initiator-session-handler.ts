import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler, ContentPart } from 'xacpp';
import type { XacppSession } from 'xacpp';

/**
 * Initiator-side XacppSessionHandler for the `chat` CLI subcommand.
 *
 * Data flow:
 *   - **onCommand**: receives `new_activity` / `invoke_activity` from the Responder
 *     (i.e., cloud messages routed through Bridge). Prints incoming messages to the terminal.
 *   - **onEvent**: returns acknowledge (the Initiator does not receive events from the Responder;
 *     it sends events via `sendReply()` to push agent replies back).
 *   - **sendReply**: sends a `message` command to the Responder, which routes it through
 *     Bridge → cloud.send() → Feishu/WeChat.
 */
export class InitiatorSessionHandler implements XacppSessionHandler {
  private readonly writer: (text: string) => void;
  private activityId: string | null = null;

  constructor(writer: (text: string) => void) {
    this.writer = writer;
  }

  async onCommand(command: XacppCommand): Promise<XacppResponse> {
    if (typeof command === 'object' && 'new_activity' in command) {
      // Responder requests a new activity — generate an ID.
      this.activityId = crypto.randomUUID();
      this.writer(`[chat] activity created: ${this.activityId}\n`);
      return { kind: 'activity_created', activity: this.activityId, agent: 'chat' };
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

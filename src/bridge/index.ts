import type { ChannelId, SessionId } from '../core/types.js';
import type { AcpSession } from '../acp/session.js';
import type { PlatformClient } from '../core/client.js';
import type { Router } from '../core/router.js';

/**
 * Bridge — bidirectional message loop between cloud platform and ACP agents.
 *
 * - Cloud → Agent: reads cloud messages, resolves agent via router,
 *   gets/creates a session, and prompts the ACP agent.
 * - Agent → Cloud: reads agent notifications, resolves the chatId from
 *   the sessionId (reverse-mapping), and sends the reply to the cloud.
 *
 * Both loops run concurrently inside run() and are stopped by close().
 */
export class Bridge {
  readonly #cloud: PlatformClient;
  readonly #acp: AcpSession;
  readonly #router: Router;

  /** sessionId → chatId reverse mapping, maintained as sessions are created. */
  readonly #sessionToChat = new Map<SessionId, ChannelId>();

  #abortCtrl = new AbortController();
  #closed = false;

  constructor(cloud: PlatformClient, acp: AcpSession, router: Router) {
    this.#cloud = cloud;
    this.#acp = acp;
    this.#router = router;
  }

  /**
   * Run the bidirectional message loop.
   * Starts two concurrent async loops:
   *   1. cloudMessagesLoop — forwards cloud messages to ACP agents.
   *   2. agentNotificationsLoop — forwards agent replies back to the cloud.
   *
   * Both loops abort when close() is called or the instance is destroyed.
   */
  async run(): Promise<void> {
    if (this.#closed) return;

    const { signal } = this.#abortCtrl;

    // Cloud → Agent loop
    const cloudMessagesLoop = (async () => {
      try {
        for await (const msg of this.#cloud.messages()) {
          if (signal.aborted) break;

          const agentId = this.#router.resolve(msg.chatId);
          if (!agentId) continue; // no agent registered for this chatId — discard

          const sessionId = await this.#acp.getOrCreateSession(msg.chatId);

          // Build reverse mapping so we can route replies back
          this.#sessionToChat.set(sessionId, msg.chatId);

          let text: string;
          if (msg.content.type === 'text') {
            text = msg.content.text;
          } else if (msg.content.type === 'image') {
            text = `[image: ${msg.content.url}]`;
          } else {
            text = `[file: ${(msg.content as { name: string }).name}]`;
          }
          await this.#acp.prompt(sessionId, [{ type: 'text', text }]);
        }
      } catch (err) {
        console.error('[Bridge]', err);
        // Abort the other loop so both exit together
        this.#abortCtrl.abort();
      }
    })();

    // Agent → Cloud loop
    const agentNotificationsLoop = (async () => {
      let lastNotifSessionId: SessionId | undefined;
      try {
        for await (const notif of this.#acp.notifications()) {
          if (signal.aborted) break;

          const chatId = this.#sessionToChat.get(notif.sessionId);
          if (!chatId) continue; // no known chat for this session — discard

          lastNotifSessionId = notif.sessionId;
          try {
            await this.#cloud.send(chatId, { type: 'text', text: notif.content });
          } catch {
            // send error — continue processing other notifications
          }
        }
      } catch (err) {
        console.error('[Bridge] notifications loop error:', err);
        this.#abortCtrl.abort();
      } finally {
        // Clean up the last-seen session mapping when the notifications iterator ends
        if (lastNotifSessionId != null) {
          this.#sessionToChat.delete(lastNotifSessionId);
        }
      }
    })();

    await Promise.all([cloudMessagesLoop, agentNotificationsLoop]);
  }

  /**
   * Stop the message loop.
   * Aborts both the cloud-messages and agent-notifications loops,
   * then closes the underlying cloud and ACP connections.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortCtrl.abort();
    this.#sessionToChat.clear();
    await Promise.all([this.#cloud.close(), this.#acp.close()]);
  }
}

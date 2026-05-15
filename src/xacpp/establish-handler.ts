import { XabotSessionHandler } from './session-handler.js';
import type { XacppTransport, EstablishHandler, XacppSessionHandler, EstablishDecision } from 'xacpp';
import type { Bridge } from '../bridge/index.js';

/**
 * Handles the Establish handshake for xabot acting as the Responder.
 *
 * Flow when !credentials (challenge path):
 * 1. Initiator generates a challenge and shows it to the user.
 * 2. User manually sends the challenge to the bot via Feishu.
 * 3. The cloud message handler calls {@link submitChallenge} with the challenge text and chatId.
 * 4. When Initiator calls `Establish(null)`, the Responder waits for the challenge to arrive
 *    (via {@link submitChallenge}), then returns `{ type: 'challenge_required', challenge }`.
 * 5. Initiator compares the challenge and sends `establish_confirm`.
 * 6. Responder creates a session with `credentials = chatId` (the chatId from the cloud message
 *    that contained the challenge).
 */
export class XabotEstablishHandler implements EstablishHandler {
  private onSession: ((transport: XacppTransport, sessionId: string, credentials: string) => void) | null = null;
  private bridge: Bridge | null = null;
  private _lastHandler: XabotSessionHandler | null = null;

  /** Resolver for the Promise returned by onEstablish() when waiting for a challenge. */
  private challengeResolver: ((result: { challenge: string; chatId: string }) => void) | null = null;

  /** Cached challenge result when submitChallenge() is called before onEstablish() asks for it. */
  private pendingChallengeResult: { challenge: string; chatId: string } | null = null;

  /** The chatId from the cloud message that delivered the challenge. Used as credentials on confirm. */
  private pendingChatId: string | null = null;

  onEstablished(callback: (transport: XacppTransport, sessionId: string, credentials: string) => void): void {
    this.onSession = callback;
  }

  setBridge(bridge: Bridge): void {
    this.bridge = bridge;
  }

  get lastHandler(): XabotSessionHandler | null {
    return this._lastHandler;
  }

  /**
   * Called by the cloud message handler when a user sends a challenge string to the bot
   * via Feishu. If onEstablish() is already waiting, this unblocks it immediately;
   * otherwise the result is cached for the next onEstablish() call.
   */
  submitChallenge(challenge: string, chatId: string): void {
    const result = { challenge, chatId };
    if (this.challengeResolver) {
      const resolve = this.challengeResolver;
      this.challengeResolver = null;
      resolve(result);
    } else {
      this.pendingChallengeResult = result;
    }
  }

  async onEstablish(
    transport: XacppTransport,
    credentials?: string,
  ): Promise<EstablishDecision> {
    if (credentials) {
      return this.createSession(transport, credentials);
    }

    // Challenge path: wait for submitChallenge() to deliver the challenge + chatId.
    let result: { challenge: string; chatId: string };
    if (this.pendingChallengeResult) {
      result = this.pendingChallengeResult;
      this.pendingChallengeResult = null;
    } else {
      result = await new Promise<{ challenge: string; chatId: string }>((resolve) => {
        this.challengeResolver = resolve;
      });
    }

    this.pendingChatId = result.chatId;
    return { type: 'challenge_required', challenge: result.challenge };
  }

  async onEstablishConfirm(
    transport: XacppTransport,
  ): Promise<{ sessionId: string; handler: XacppSessionHandler; credentials: string }> {
    if (this.pendingChatId === null) {
      throw new Error('no pending challenge to confirm');
    }
    const chatId = this.pendingChatId;
    this.pendingChatId = null;
    this.pendingChallengeResult = null;
    const result = this.createSession(transport, chatId);
    return { sessionId: result.sessionId, handler: result.handler, credentials: chatId };
  }

  private createSession(
    transport: XacppTransport,
    credentials: string,
  ): EstablishDecision & { type: 'established' } {
    const sessionId = crypto.randomUUID();
    const handler = new XabotSessionHandler(sessionId);
    this._lastHandler = handler;

    if (this.bridge) {
      handler.setBridge(this.bridge);
    }
    if (this.onSession) {
      this.onSession(transport, sessionId, credentials);
    }

    return { type: 'established', sessionId, handler, credentials };
  }
}

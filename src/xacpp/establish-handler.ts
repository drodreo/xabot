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

  /** WeChat login function — called when no credentials and no challenge available. */
  private loginFn: (() => Promise<{ token: string; baseUrl: string }>) | null = null;

  /** Callback to create/connect a cloud client after login or with existing credentials. */
  private ensureCloudFn: ((token: string, baseUrl: string) => Promise<void>) | null = null;

  /** Resolved token from login or credentials parsing. */
  private resolvedBotToken: string | null = null;

  /** Resolved baseUrl from login or credentials parsing. */
  private resolvedBaseUrl: string | null = null;

  onEstablished(callback: (transport: XacppTransport, sessionId: string, credentials: string) => void): void {
    this.onSession = callback;
  }

  setBridge(bridge: Bridge): void {
    this.bridge = bridge;
  }

  get lastHandler(): XabotSessionHandler | null {
    return this._lastHandler;
  }

  setLoginFn(fn: () => Promise<{ token: string; baseUrl: string }>): void {
    this.loginFn = fn;
  }

  setEnsureCloudFn(fn: (token: string, baseUrl: string) => Promise<void>): void {
    this.ensureCloudFn = fn;
  }

  clearPending(): void {
    this.pendingChallengeResult = null;
    this.pendingChatId = null;
    this.resolvedBotToken = null;
    this.resolvedBaseUrl = null;
    this.challengeResolver = null;
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
      // Attempt to parse as WeChat JSON credentials
      try {
        const parsed = JSON.parse(credentials) as unknown;
        if (typeof parsed === 'object' && parsed !== null && 'botToken' in parsed) {
          const { botToken, baseUrl } = parsed as { botToken: string; baseUrl?: string };
          if (this.ensureCloudFn) {
            await this.ensureCloudFn(botToken, baseUrl ?? '');
          }
          this.resolvedBotToken = botToken;
          this.resolvedBaseUrl = baseUrl ?? null;
          return this.createSession(transport, credentials);
        }
      } catch {
        // Not JSON — treat as Feishu chatId string
      }
      // Feishu path: credentials is a plain chatId string
      return this.createSession(transport, credentials);
    }

    // No credentials — try WeChat login first
    if (this.loginFn && this.ensureCloudFn) {
      const { token, baseUrl } = await this.loginFn();
      await this.ensureCloudFn(token, baseUrl);
      this.resolvedBotToken = token;
      this.resolvedBaseUrl = baseUrl;
      // Fall through to challenge path (same as Feishu)
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

    let credentials: string;
    if (this.resolvedBotToken !== null) {
      // WeChat: assemble JSON credentials
      credentials = JSON.stringify({
        botToken: this.resolvedBotToken,
        baseUrl: this.resolvedBaseUrl ?? '',
        chatId,
      });
    } else {
      // Feishu: plain chatId
      credentials = chatId;
    }

    this.pendingChatId = null;
    this.pendingChallengeResult = null;
    this.resolvedBotToken = null;
    this.resolvedBaseUrl = null;

    const decision = this.createSession(transport, credentials);
    return { sessionId: decision.sessionId, handler: decision.handler, credentials };
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

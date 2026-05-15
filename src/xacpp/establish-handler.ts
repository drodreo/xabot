import { XabotSessionHandler } from './session-handler.js';
import type { XacppTransport, EstablishHandler, XacppSessionHandler, EstablishDecision } from 'xacpp';
import type { Bridge } from '../bridge/index.js';

/**
 * EstablishHandler implementation for xabot.
 *
 * Triggered when the downstream Agent (Initiator) initiates establish.
 * Supports three-step handshake:
 *   1. First connection (credentials === null) → return challenge_required
 *   2. Initiator confirms challenge → onEstablishConfirm creates session
 *   3. Non-first connection (credentials !== null) → create session directly
 */
export class XabotEstablishHandler implements EstablishHandler {
  private onSession: ((transport: XacppTransport, sessionId: string, credentials: string | null) => void) | null = null;
  private bridge: Bridge | null = null;
  private _lastHandler: XabotSessionHandler | null = null;
  private pendingChallenge: string | null = null;

  /** Register callback: notify Bridge after successful establish. */
  onEstablished(callback: (transport: XacppTransport, sessionId: string, credentials: string | null) => void): void {
    this.onSession = callback;
  }

  /** Register Bridge reference (called before establish). */
  setBridge(bridge: Bridge): void {
    this.bridge = bridge;
  }

  /** Get the handler created by the last establish (for Bridge injection). */
  get lastHandler(): XabotSessionHandler | null {
    return this._lastHandler;
  }

  async onEstablish(
    transport: XacppTransport,
    credentials: string | null,
  ): Promise<EstablishDecision> {
    if (credentials !== null) {
      return this.createSession(transport, credentials);
    }
    const challenge = crypto.randomUUID();
    this.pendingChallenge = challenge;
    return { type: 'challenge_required', challenge };
  }

  async onEstablishConfirm(
    transport: XacppTransport,
  ): Promise<{ sessionId: string; handler: XacppSessionHandler }> {
    if (this.pendingChallenge === null) {
      throw new Error('no pending challenge to confirm');
    }
    this.pendingChallenge = null;
    return this.createSession(transport, null);
  }

  private createSession(
    transport: XacppTransport,
    credentials: string | null,
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

    return { type: 'established', sessionId, handler };
  }
}

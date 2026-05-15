import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler } from 'xacpp';
import type { Bridge } from '../bridge/index.js';

/**
 * XACPP SessionHandler implementation for xabot.
 *
 * Handles Commands and Events from the downstream Agent, bridging them to Bridge via callbacks.
 */
export class XabotSessionHandler implements XacppSessionHandler {
  readonly sessionId: string;
  private bridge: Bridge | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Register Bridge reference (injected externally after establish completes). */
  setBridge(bridge: Bridge): void {
    this.bridge = bridge;
  }

  async onCommand(command: XacppCommand): Promise<XacppResponse> {
    if (!this.bridge) return { kind: 'acknowledge' };
    return this.bridge.handleCommand(command);
  }

  async onEvent(event: XacppActivityEvent): Promise<XacppResponse> {
    if (!this.bridge) return { kind: 'acknowledge' };
    return this.bridge.handleEvent(event.activity, event);
  }
}

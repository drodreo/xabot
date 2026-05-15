import { XabotSessionHandler } from './session-handler.js';
import type { XacppTransport, EstablishHandler, XacppSessionHandler, EstablishDecision } from 'xacpp';
import type { Bridge } from '../bridge/index.js';

/**
 * xabot 的 EstablishHandler 实现。
 *
 * 下游 Agent（Initiator）发起 establish 时触发。
 * 支持三步握手：
 *   1. 首次连接（credentials === null）→ 返回 challenge_required
 *   2. Initiator 确认 challenge → onEstablishConfirm 创建 session
 *   3. 非首次连接（credentials !== null）→ 直接创建 session
 */
export class XabotEstablishHandler implements EstablishHandler {
  private onSession: ((transport: XacppTransport, sessionId: string, credentials: string | null) => void) | null = null;
  private bridge: Bridge | null = null;
  private _lastHandler: XabotSessionHandler | null = null;
  private pendingChallenge: string | null = null;

  /** 注册回调：establish 成功后通知 Bridge。 */
  onEstablished(callback: (transport: XacppTransport, sessionId: string, credentials: string | null) => void): void {
    this.onSession = callback;
  }

  /** 注册 Bridge 引用（在 establish 之前调用）。 */
  setBridge(bridge: Bridge): void {
    this.bridge = bridge;
  }

  /** 获取最后一次 establish 创建的 handler（用于注入 Bridge）。 */
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

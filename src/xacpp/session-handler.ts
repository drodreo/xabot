import type { XacppCommand, XacppActivityEvent, XacppResponse, XacppSessionHandler } from 'xacpp';
import type { Bridge } from '../bridge/index.js';

/**
 * xabot 的 XacppSessionHandler 实现。
 *
 * 处理下游 Agent 发来的 Command 和 Event，通过回调桥接到 Bridge。
 */
export class XabotSessionHandler implements XacppSessionHandler {
  readonly sessionId: string;
  private bridge: Bridge | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 注册 Bridge 引用（establish 完成后由外部注入）。 */
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

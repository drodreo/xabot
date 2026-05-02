import type { ChannelId, SessionId } from '../core/types.js';

/** Minimal notification from an ACP agent. */
export interface AgentNotification {
  sessionId: SessionId;
  content: string;
}

/** Permission request from an ACP agent. */
export interface PermissionRequest {
  sessionId: SessionId;
  name: string;
  options: string[];
}

/** Proactive message sent by a downstream agent (no ACP session required). */
export interface ProactiveMessage {
  chatId: ChannelId;
  content: string;
}

/**
 * AcpHandler processes ACP events and routes them through channels.
 * It queues notifications, permission requests, and proactive messages
 * for downstream consumers.
 *
 * Uses a listener pattern so multiple concurrent async iterators can consume
 * notifications/permissionRequests without monkey-patching each other.
 */
export class AcpHandler {
  private notificationQueue: AgentNotification[] = [];
  private permissionQueue: PermissionRequest[] = [];
  private proactiveQueue: ProactiveMessage[] = [];

  /** Active notification listeners, each with its own queue. */
  private notificationListeners = new Set<(n: AgentNotification) => void>();
  /** Active permission listeners, each with its own queue. */
  private permissionListeners = new Set<(p: PermissionRequest) => void>();
  /** Active proactive message listeners, each with its own queue. */
  private proactiveListeners = new Set<(p: ProactiveMessage) => void>();

  // -----------------------------------------------------------------------
  // Listener registration (used by AcpSession notifications/permissionRequests)
  // -----------------------------------------------------------------------

  /**
   * Register a listener for incoming notifications.
   * The listener is called for every notification pushed via `pushNotification`.
   * @returns An unsubscribe function.
   */
  addNotificationListener(listener: (n: AgentNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * Register a listener for incoming permission requests.
   * @returns An unsubscribe function.
   */
  addPermissionListener(listener: (p: PermissionRequest) => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  /**
   * Register a listener for incoming proactive messages.
   * @returns An unsubscribe function.
   */
  addProactiveListener(listener: (p: ProactiveMessage) => void): () => void {
    this.proactiveListeners.add(listener);
    return () => this.proactiveListeners.delete(listener);
  }

  // -----------------------------------------------------------------------
  // Push / drain (preserved for test compatibility)
  // -----------------------------------------------------------------------

  pushNotification(n: AgentNotification): void {
    this.notificationQueue.push(n);
    for (const listener of this.notificationListeners) {
      listener(n);
    }
  }

  pushPermission(p: PermissionRequest): void {
    this.permissionQueue.push(p);
    for (const listener of this.permissionListeners) {
      listener(p);
    }
  }

  pushProactive(msg: ProactiveMessage): void {
    this.proactiveQueue.push(msg);
    for (const listener of this.proactiveListeners) {
      listener(msg);
    }
  }

  drainNotifications(): AgentNotification[] {
    const out = this.notificationQueue;
    this.notificationQueue = [];
    return out;
  }

  drainPermissions(): PermissionRequest[] {
    const out = this.permissionQueue;
    this.permissionQueue = [];
    return out;
  }

  drainProactive(): ProactiveMessage[] {
    const out = this.proactiveQueue;
    this.proactiveQueue = [];
    return out;
  }
}

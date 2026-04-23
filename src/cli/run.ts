/**
 * run CLI subcommand.
 *
 * Starts the full Bridge mode:
 *   - Connects the cloud PlatformClient.
 *   - Connects the ACP session over stdin/stdout.
 *   - Registers agentId → chatIds in the Router.
 *   - Runs the Bridge bidirectional message loop.
 *
 * Handles SIGINT and SIGTERM gracefully, then exits cleanly.
 */

import type { PlatformClient } from '../core/client.js';
import type { AcpSession } from '../acp/session.js';
import type { Bridge } from '../bridge/index.js';
import type { AgentId, ChannelId } from '../core/types.js';
import type { Router } from '../core/router.js';

export interface RunOptions {
  /** agentId registered with the ACP downstream. */
  agentId: AgentId;
  /** chatIds this agent owns — used to initialise the Router. */
  chatIds: ChannelId[];
  /** Output writer — defaults to process.stdout.write. */
  writer?: (chunk: string) => void;
  /**
   * Override Bridge construction — intended for testing.
   * When provided, the caller supplies the Bridge instance directly.
   */
  bridgeFactory?: (cloud: PlatformClient, acp: AcpSession, router: Router) => Bridge;
}

/**
 * Start Bridge mode with graceful shutdown on SIGINT/SIGTERM.
 *
 * @param cloud   - A connected PlatformClient.
 * @param acp    - A connected AcpSession.
 * @param router - A Router with agentId → chatIds already registered.
 * @param options
 */
export async function run(
  cloud: PlatformClient,
  acp: AcpSession,
  router: Router,
  options: RunOptions,
): Promise<void> {
  const {
    agentId,
    chatIds,
    writer = (chunk: string) => process.stdout.write(chunk),
    bridgeFactory,
  } = options;

  // Register this agent's chatIds in the router.
  router.register(agentId, chatIds);

  const bridge = bridgeFactory
    ? bridgeFactory(cloud, acp, router)
    : new (await import('../bridge/index.js')).Bridge(cloud, acp, router);

  // Track shutdown so we only close once.
  let closed = false;
  const doClose = async () => {
    if (closed) return;
    closed = true;
    writer('正在关闭 Bridge...\n');
    await bridge.close();
    writer('Bridge 已关闭，退出。\n');
  };

  // Wire up termination signals.
  const onSignal = (label: string) => {
    writer(`\n收到 ${label}，开始优雅关闭...\n`);
    void doClose().then(() => process.exit(0));
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  writer(`Bridge 模式启动，agentId=${agentId}，chatIds=[${chatIds.join(', ')}]\n`);

  await bridge.run();
  // Bridge.run() only resolves when the loops end (or close() was called).
  await doClose();
}

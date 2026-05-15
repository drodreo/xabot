/**
 * run CLI subcommand.
 *
 * Starts the full Bridge mode:
 *   - Connects the cloud PlatformClient.
 *   - Establishes XACPP peer over stdin/stdout.
 *   - Runs the Bridge bidirectional message loop.
 *
 * Handles SIGINT and SIGTERM gracefully, then exits cleanly.
 */

import type { ChannelId } from '../core/types.js';
import type { Bridge } from '../bridge/index.js';
import type { XacppPeer } from 'xacpp';

export interface RunOptions {
  /** chatIds this agent owns. */
  chatIds: ChannelId[];
  /** Output writer — defaults to process.stdout.write. */
  writer?: (chunk: string) => void;
}

/**
 * Start Bridge mode with graceful shutdown on SIGINT/SIGTERM.
 *
 * @param bridge - A Bridge instance wired to cloud and transport.
 * @param peer   - A connected XacppPeer.
 * @param options
 */
export async function run(
  bridge: Bridge,
  peer: XacppPeer,
  options: RunOptions,
): Promise<void> {
  const {
    chatIds,
    writer = (chunk: string) => process.stdout.write(chunk),
  } = options;

  // Track shutdown so we only close once.
  let closed = false;
  const doClose = async () => {
    if (closed) return;
    closed = true;
    writer('正在关闭 Bridge...\n');
    await bridge.close();
    await peer.disconnect();
    writer('Bridge 已关闭，退出。\n');
  };

  // Wire up termination signals.
  const onSignal = (label: string) => {
    writer(`\n收到 ${label}，开始优雅关闭...\n`);
    void doClose().then(() => process.exit(0));
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  writer(`Bridge 模式启动，chatIds=[${chatIds.join(', ')}]\n`);

  await bridge.run();
  // Bridge.run() only resolves when the loops end (or close() was called).
  await doClose();
}

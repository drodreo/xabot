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

import type { Bridge } from '../bridge/index.js';
import type { XacppPeer } from 'xacpp';
import { createLogger } from '../core/logger.js';
const log = createLogger('run');

/**
 * Start Bridge mode with graceful shutdown on SIGINT/SIGTERM.
 *
 * @param bridge - A Bridge instance wired to cloud and transport.
 * @param peer   - A connected XacppPeer.
 */
export async function run(bridge: Bridge, peer: XacppPeer): Promise<void> {
  // Track shutdown so we only close once.
  let closed = false;
  const doClose = async () => {
    if (closed) return;
    closed = true;
    log.info('Shutting down Bridge...');
    await bridge.close();
    await peer.disconnect();
    log.info('Bridge closed, exiting.');
  };

  // Wire up termination signals.
  const onSignal = (label: string) => {
    log.info('Received %s, starting graceful shutdown', label);
    void doClose().then(() => process.exit(0));
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  log.info('Bridge mode started');

  await bridge.run();
  // Bridge.run() only resolves when the loops end (or close() was called).
  await doClose();
}

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

export interface RunOptions {
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
    writer = (chunk: string) => process.stdout.write(chunk),
  } = options;

  // Track shutdown so we only close once.
  let closed = false;
  const doClose = async () => {
    if (closed) return;
    closed = true;
    writer('Shutting down Bridge...\n');
    await bridge.close();
    await peer.disconnect();
    writer('Bridge closed, exiting.\n');
  };

  // Wire up termination signals.
  const onSignal = (label: string) => {
    writer(`\nReceived ${label}, starting graceful shutdown...\n`);
    void doClose().then(() => process.exit(0));
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  writer('Bridge mode started\n');

  await bridge.run();
  // Bridge.run() only resolves when the loops end (or close() was called).
  await doClose();
}

/**
 * health CLI subcommand.
 *
 * Verifies that the platform client can connect and authenticate,
 * then checks that credentials are valid by calling healthCheck().
 */

import type { PlatformClient } from '../core/client.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('health');

/**
 * Check the health of a connected PlatformClient.
 *
 * @param client  - A connected PlatformClient.
 * @throws If the client fails to respond correctly.
 */
export async function health(client: PlatformClient): Promise<void> {
  try {
    await client.healthCheck();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Health check failed: %s', msg);
    throw err;
  }

  log.info('health: status=ok platform=%s', client.platform);
}

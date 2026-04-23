/**
 * health CLI subcommand.
 *
 * Verifies that the platform client can connect and authenticate,
 * then checks that credentials are valid by calling healthCheck().
 */

import type { PlatformClient } from '../core/client.js';

export interface HealthOptions {
  /** Output writer — defaults to process.stdout.write. */
  writer?: (chunk: string) => void;
}

/**
 * Check the health of a connected PlatformClient.
 *
 * @param client  - A connected PlatformClient.
 * @param options - Optional writer injection.
 * @throws If the client fails to respond correctly.
 */
export async function health(
  client: PlatformClient,
  options: HealthOptions = {},
): Promise<void> {
  const { writer = (chunk: string) => process.stdout.write(chunk) } = options;

  try {
    await client.healthCheck();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writer(`❌ 健康检查失败: ${msg}\n`);
    throw err;
  }

  writer(`✅ ${client.platform} 连接正常\n`);
}

/**
 * discover CLI subcommand.
 *
 * Flow:
 *  1. Generate a random 6-char pairing code.
 *  2. Connect to the cloud via the provided PlatformClient.
 *  3. Output the pairing code instruction to the provided writer.
 *  4. Poll messages() — first message whose text == code wins; extract chatId.
 *  5. Close the connection and return the chatId.
 *  6. Throw DiscoverTimeoutError on timeout.
 */

import type { PlatformClient } from '../core/client.js';
import type { ChannelId } from '../core/types.js';
import { generatePairingCode } from '../core/pairing.js';

/** Thrown when the pairing window expires before a matching message arrives. */
export class DiscoverTimeoutError extends Error {
  readonly code = 'DISCOVER_TIMEOUT';
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms — no matching pairing code received.`);
  }
}

export interface DiscoverOptions {
  /** Milliseconds to wait for the pairing message. Defaults to 60000. */
  timeoutMs?: number;
  /**
   * Output writer — allows tests to capture stdout without real I/O.
   * Defaults to process.stdout.write when omitted.
   */
  writer?: (chunk: string) => void;
  /**
   * Override the pairing code generation — intended for testing.
   * When provided, generatePairingCode is not called.
   */
  pairingCode?: string;
}

/**
 * Safely close a PlatformClient, ignoring any thrown exceptions.
 */
async function safeClose(client: PlatformClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // ignore
  }
}

/**
 * Discover a chatId by awaiting a pairing-code message from the user.
 *
 * @param client   - A connected PlatformClient (caller is responsible for calling connect()).
 * @param options  - timeoutMs and optional writer injection.
 * @returns The ChannelId (chatId) of the user who sent the matching pairing code.
 */
export async function discover(
  client: PlatformClient,
  options: DiscoverOptions = {},
): Promise<ChannelId> {
  const { timeoutMs = 60_000, writer = (chunk: string) => process.stdout.write(chunk), pairingCode } = options;

  const code = pairingCode ?? generatePairingCode(6);

  // Tell the user which code to send
  const seconds = timeoutMs / 1000;
  writer(`请在 ${seconds} 秒内给 bot 发送以下配对码：${code}\n`);

  // Race: incoming messages vs. timeout
  const deadline = Date.now() + timeoutMs;

  for await (const msg of client.messages()) {
    // Process message first; only check timeout when there's no match.
    if (msg.content.type === 'text' && msg.content.text === code) {
      await safeClose(client);
      writer(`配对成功，chatId：${msg.chatId}\n`);
      return msg.chatId;
    }

    if (Date.now() > deadline) {
      await safeClose(client);
      throw new DiscoverTimeoutError(timeoutMs);
    }
  }

  // Stream ended without a match
  await safeClose(client);
  throw new DiscoverTimeoutError(timeoutMs);
}

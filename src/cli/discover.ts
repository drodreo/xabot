/**
 * discover CLI subcommand.
 *
 * Flow:
 *  1. Generate a random 6-char pairing code.
 *  2. Connect to the cloud via the provided PlatformClient.
 *  3. Run startup diagnostics (REST API check + event subscription check for Feishu).
 *  4. Output the pairing code instruction to the provided writer.
 *  5. Poll messages() — first message whose text == code wins; extract chatId.
 *  6. Close the connection and return the chatId.
 *  7. Throw DiscoverTimeoutError on timeout.
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
   * Stdout writer — used for structured result output (JSON).
   * Defaults to process.stdout.write when omitted.
   */
  writer?: (chunk: string) => void;
  /**
   * Stderr writer — used for human-readable diagnostics and prompts.
   * Defaults to process.stderr.write when omitted.
   */
  stderr?: (chunk: string) => void;
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
 * Feishu-specific diagnostics after connect().
 * All failures are warnings — they never block the discover flow.
 */
async function runFeishuDiagnostics(
  client: PlatformClient & { listEventSubscriptions?: () => Promise<string[]> },
  writer: (chunk: string) => void,
): Promise<void> {
  // 1. REST API health check
  try {
    await client.healthCheck();
    writer(`✅ REST API reachable\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writer(`⚠️ REST API health check failed: ${msg}\n`);
    // Non-fatal — continue to pairing phase
  }

  // 2. Event subscription list (Feishu only)
  if (client.listEventSubscriptions) {
    try {
      const events = await client.listEventSubscriptions();
      writer(`Subscribed events: [${events.join(', ')}]\n`);
      if (events.includes('im.message.receive_v1')) {
        writer(`✅ Subscribed to im.message.receive_v1\n`);
      } else {
        writer(`⚠️ Not subscribed to im.message.receive_v1, message reception may fail\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer(`⚠️ Event subscription query failed: ${msg}\n`);
      // Non-fatal — doesn't mean pairing won't work
    }
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
  const {
    timeoutMs = 60_000,
    writer = (chunk: string) => process.stdout.write(chunk),
    stderr = (chunk: string) => process.stderr.write(chunk),
    pairingCode,
  } = options;

  // Run Feishu-specific diagnostics (safe to call on any PlatformClient —
  // FeishuClient has listEventSubscriptions, other clients don't).
  // Diagnostics go to stderr so they don't pollute the JSON result on stdout.
  await runFeishuDiagnostics(
    client as PlatformClient & { listEventSubscriptions?: () => Promise<string[]> },
    stderr,
  );

  const code = pairingCode ?? generatePairingCode(6);

  // Tell the user which code to send (human-readable prompt → stderr)
  const seconds = timeoutMs / 1000;
  stderr(`Send the following pairing code to the bot within ${seconds} seconds: ${code}\n`);

  // Race: message matching vs. timeout
  const matchPromise = (async (): Promise<ChannelId | undefined> => {
    for await (const msg of client.messages()) {
      if (msg.content.type === 'text' && msg.content.text === code) {
        return msg.chatId;
      }
    }
    // Stream ended without a match
    return undefined;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chatId = await Promise.race([
      matchPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DiscoverTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);

    if (chatId === undefined) {
      throw new DiscoverTimeoutError(timeoutMs);
    }

    // Structured JSON result → stdout (one line, easy to pipe/parse)
    writer(JSON.stringify({ ok: true, chatId }) + '\n');
    return chatId;
  } finally {
    clearTimeout(timer);
    await safeClose(client);
    // Prevent unhandled rejection if matchPromise settles after race ended.
    matchPromise.catch(() => {});
  }
}

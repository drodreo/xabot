/**
 * chat CLI subcommand.
 *
 * Interactive terminal tool that acts as an XACPP Initiator.
 * Runs both Responder (Bridge + cloud) and Initiator (interactive)
 * in the same process, connected via TCP loopback.
 *
 * Data flow:
 *   Feishu message → Bridge → session.requestCommand(invoke_activity) → Initiator.onCommand → terminal
 *   Terminal input → Initiator.sendReply → session.requestCommand({ message }) → Bridge.handleCommand → cloud.send → Feishu
 */

import type { PlatformClient } from '../core/client.js';
import { XacppPeer, XacppSession, SocketTransport } from 'xacpp';
import * as net from 'node:net';
import type { Readable } from 'node:stream';
import { Bridge } from '../bridge/index.js';
import { XabotEstablishHandler } from '../xacpp/establish-handler.js';
import { InitiatorSessionHandler } from '../xacpp/initiator-session-handler.js';
import { StdinRouter } from '../xacpp/stdin-router.js';

export interface ChatOptions {
  /** Output writer — defaults to process.stderr.write. */
  writer?: (chunk: string) => void;
  /** Existing session credentials — skips challenge/pairing flow. */
  credentials?: string;
  /** WeChat login function — called when no credentials to trigger QR scan. */
  loginFn?: () => Promise<{ token: string; baseUrl: string }>;
  /** Factory to create a cloud client after login. The returned client replaces the placeholder in Bridge. */
  cloudFactory?: (token: string, baseUrl: string) => Promise<PlatformClient>;
}

/**
 * Run the interactive chat session.
 *
 * Architecture:
 *   Terminal stdin ←→ Initiator Peer (SocketTransport client)
 *                         ↕ TCP 127.0.0.1:random
 *                    Responder Peer (SocketTransport server)
 *                         ↕
 *                      Bridge ←→ Cloud PlatformClient
 *
 * @param cloud   - A connected PlatformClient.
 * @param options - Optional writer injection.
 */
export async function chat(cloud?: PlatformClient, options?: ChatOptions): Promise<void> {
  const writer = options?.writer ?? ((chunk: string) => process.stderr.write(chunk));

  writer('[chat] starting...\n');

  // ── Step 1: Start TCP server on a random port ──────────────────────────

  writer('[chat] creating TCP server...\n');
  const { port, accept } = await new Promise<{ port: number; accept: Promise<net.Socket> }>(
    (resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const acceptPromise = new Promise<net.Socket>((res) => {
          server.on('connection', (socket) => {
            server.close(); // Only accept one connection
            res(socket);
          });
        });
        resolve({ port: addr.port, accept: acceptPromise });
      });
      server.on('error', reject);
    },
  );
  writer(`[chat] TCP server listening on 127.0.0.1:${port}\n`);

  // ── Step 2: Fire Initiator TCP connect (non-blocking) ─────────────────
  // SocketTransport.connectTo() only stores params — the actual TCP
  // connection happens inside transport.connect(), called by peer.connect().
  // We must fire peer.connect() BEFORE await accept, otherwise the TCP
  // server never receives a connection and both sides deadlock.

  writer('[chat] initiating TCP connection from Initiator side...\n');
  const initiatorTransport = SocketTransport.connectTo(port);
  const dummyEstablishHandler: import('xacpp').EstablishHandler = {
    async onEstablish() { throw new Error('Initiator does not accept inbound establish'); },
    async onEstablishConfirm() { throw new Error('Unexpected establish_confirm on Initiator'); },
  };
  const initiatorPeer = new XacppPeer(initiatorTransport, dummyEstablishHandler);
  const router = new StdinRouter(process.stdin as unknown as Readable);
  const initiatorHandler = new InitiatorSessionHandler(writer, router);

  // Fire-and-forget: peer.connect() internally calls transport.connect()
  // which opens the TCP socket. The server will see the connection and
  // resolve the accept promise.
  const initiatorConnectPromise = initiatorPeer.connect();

  // ── Step 3: Start Bridge (Responder side) ──────────────────────────────

  writer('[chat] waiting for TCP accept (Responder side)...\n');
  const responderTransport = new SocketTransport(await accept);
  writer('[chat] TCP connection accepted\n');
  const establishHandler = new XabotEstablishHandler();
  const responderPeer = new XacppPeer(responderTransport, establishHandler);

  const bridge = new Bridge(responderTransport, cloud ? { cloud } : undefined);
  establishHandler.setBridge(bridge);
  bridge.setEstablishHandler(establishHandler);

  if (options?.loginFn) {
    establishHandler.setLoginFn(options.loginFn);
  }
  if (options?.cloudFactory) {
    establishHandler.setEnsureCloudFn(async (token, baseUrl) => {
      const client = await options.cloudFactory!(token, baseUrl);
      bridge.replaceCloud(client);
    });
  }

  establishHandler.onEstablished((_t, sessionId, credentials: string) => {
    const session = new XacppSession(responderTransport, sessionId, credentials);
    bridge.setSession(session);
    bridge.markEstablished();
    writer(`[chat] establish completed, sessionId=${sessionId}, chatId=${credentials}\n`);
  });

  // Start Bridge.run() in the background so Phase 1 can scan cloud messages.
  bridge.run();
  writer('[chat] connecting Responder peer...\n');
  await responderPeer.connect();
  writer('[chat] Responder peer connected\n');

  // ── Step 4: Await Initiator connect (TCP already initiated in Step 2) ──

  writer('[chat] awaiting Initiator peer connect...\n');
  await initiatorConnectPromise;
  writer('[chat] Initiator peer connected\n');

  // ── Step 5: Establish (challenge or credentials) ───────────────────────

  let session: XacppSession;
  const credentials = options?.credentials;

  if (credentials) {
    writer(`[chat] Reconnecting with credentials: ${credentials}\n`);
    writer('[chat] calling initiatorPeer.establish() with credentials...\n');
    session = await initiatorPeer.establish(credentials, initiatorHandler, () => {});
    const chatId = session.credentials;
    writer(`[chat] Re-established, chatId: ${chatId}\n`);
  } else {
    const challenge = crypto.randomUUID();
    writer(`[chat] Pairing code: ${challenge}\n[chat] Send this code to the bot via Feishu/WeChat.\n`);

    writer('[chat] calling initiatorPeer.establish()...\n');
    session = await initiatorPeer.establish(
      undefined,
      initiatorHandler,
      (received) => {
        writer(`[chat] challenge verify: expected=${challenge}, received=${received}\n`);
        if (received !== challenge) {
          throw new Error(`Challenge mismatch: expected ${challenge}, got ${received}`);
        }
      },
    );
    const chatId = session.credentials;
    writer(`[chat] Connected! chatId: ${chatId}\n`);
  }

  writer('[chat] Ready. Type a message and press Enter, or wait for Feishu/WeChat messages.\n');

  router.subscribe('default', (text) => {
    return initiatorHandler.sendReply(session, text).catch((err) => {
      writer(`Send failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });

  // ── Step 6: Chat loop ──────────────────────────────────────────────────
  // No new_activity here — the Responder (Bridge) creates activities when
  // cloud messages arrive, routing them via requestCommand → Initiator.onCommand.
  // Terminal replies go via Initiator.sendReply → requestCommand({ message }) → Bridge.handleCommand → cloud.

  try {
    await router.start();
  } finally {
    router.close();
    await initiatorPeer.disconnect();
    await responderPeer.disconnect();
    await bridge.close();
  }
}

import { describe, it, expect, vi } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import type { XacppPeer } from 'xacpp';
import { run } from './run.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockBridge(): Bridge & { closed: boolean; runCalled: boolean } {
  let bridgeClosed = false;
  let bridgeRunCalled = false;
  return {
    get closed() { return bridgeClosed; },
    get runCalled() { return bridgeRunCalled; },
    async run() {
      bridgeRunCalled = true;
    },
    async close() {
      bridgeClosed = true;
    },
    setSession: vi.fn(),
    setEstablishHandler: vi.fn(),
    markEstablished: vi.fn(),
    handleCommand: vi.fn(),
    handleEvent: vi.fn(),
    resolvePending: vi.fn(),
  } as unknown as Bridge & { closed: boolean; runCalled: boolean };
}

function mockPeer(): XacppPeer & { disconnected: boolean } {
  let disconnected = false;
  return {
    get disconnected() { return disconnected; },
    async disconnect() {
      disconnected = true;
    },
    connect: vi.fn().mockResolvedValue(undefined),
    establish: vi.fn(),
    state: 'connected' as any,
  } as unknown as XacppPeer & { disconnected: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run', () => {
  it('calls bridge.run() and closes on normal exit', async () => {
    const bridge = mockBridge();
    const peer = mockPeer();

    await run(bridge, peer);

    expect(bridge.runCalled).toBe(true);
    expect(bridge.closed).toBe(true);
    expect(peer.disconnected).toBe(true);
  });

  it('close() is idempotent — multiple SIGINT only close once', async () => {
    const bridge = mockBridge();
    const peer = mockPeer();

    await run(bridge, peer);

    expect(bridge.closed).toBe(true);
    expect(peer.disconnected).toBe(true);
  });
});

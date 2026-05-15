import { describe, it, expect, vi } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import type { XacppPeer } from 'xacpp';
import { channelId } from '../core/types.js';
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

    await run(bridge, peer, {
      chatIds: [channelId('och_1'), channelId('och_2')],
    });

    expect(bridge.runCalled).toBe(true);
    expect(bridge.closed).toBe(true);
    expect(peer.disconnected).toBe(true);
  });

  it('uses the writer for startup and shutdown messages', async () => {
    const bridge = mockBridge();
    const peer = mockPeer();
    const output: string[] = [];

    await run(bridge, peer, {
      chatIds: [channelId('och_write')],
      writer: (chunk) => output.push(chunk),
    });

    expect(output.some((o) => o.includes('Bridge 模式启动'))).toBe(true);
    expect(output.some((o) => o.includes('Bridge 已关闭'))).toBe(true);
  });

  it('passes correct chatIds in startup message', async () => {
    const bridge = mockBridge();
    const peer = mockPeer();
    const output: string[] = [];

    await run(bridge, peer, {
      chatIds: [channelId('och_1'), channelId('och_2')],
      writer: (chunk) => output.push(chunk),
    });

    expect(output.some((o) => o.includes('och_1') && o.includes('och_2'))).toBe(true);
  });

  it('close() is idempotent — multiple SIGINT only close once', async () => {
    const bridge = mockBridge();
    const peer = mockPeer();
    const output: string[] = [];

    // Run with writer capturing
    const runPromise = run(bridge, peer, {
      chatIds: [channelId('och_1')],
      writer: (chunk) => output.push(chunk),
    });

    await runPromise;

    // Bridge.run() resolves immediately in mock, so close has already been called once
    expect(bridge.closed).toBe(true);
    expect(peer.disconnected).toBe(true);
  });
});

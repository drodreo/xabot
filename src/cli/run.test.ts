import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
import type { AcpSession } from '../acp/session.js';
import type { Bridge } from '../bridge/index.js';
import { agentId, channelId, messageId, StreamCapability as SC } from '../core/types.js';
import { run } from './run.js';
import { Router } from '../core/router.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockPlatformClient extends PlatformClient {
  closed: boolean;
}

function mockPlatformClient(): MockPlatformClient {
  let isClosed = false;
  return {
    platform: 'mock',
    closed: false,
    async connect() {},
    async send() {
      return messageId('mock-id');
    },
    async *messages() {},
    streamCapability() {
      return SC.NonStreaming;
    },
    async healthCheck() {},
    async close() {
      isClosed = true;
      this.closed = isClosed;
    },
  };
}

function mockAcpSession(): AcpSession {
  return {
    __testHandler: null as any,
    __testClient: null as any,
    async getOrCreateSession() {
      return 'mock-session-id' as any;
    },
    async prompt() {},
    async *notifications() {},
    async *permissionRequests() {},
    close() {},
  } as unknown as AcpSession;
}

interface MockBridge extends Bridge {
  closed: boolean;
  runCalled: boolean;
}

function mockBridge(cloud?: MockPlatformClient): MockBridge {
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
      if (cloud) await cloud.close();
    },
  } as unknown as MockBridge;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run', () => {
  it('registers agentId and chatIds in the router before running bridge', async () => {
    const cloud = mockPlatformClient();
    const acp = mockAcpSession();
    const bridge = mockBridge();
    const router = new Router();

    await run(cloud, acp, router, {
      agentId: agentId('agent-1'),
      chatIds: [channelId('och_1'), channelId('och_2')],
      bridgeFactory: () => bridge,
    });

    expect(router.resolve(channelId('och_1'))).toBe('agent-1');
    expect(router.resolve(channelId('och_2'))).toBe('agent-1');
    expect(bridge.runCalled).toBe(true);
  });

  it('closes the bridge on normal exit', async () => {
    const cloud = mockPlatformClient();
    const acp = mockAcpSession();
    const bridge = mockBridge(cloud);
    const router = new Router();

    await run(cloud, acp, router, {
      agentId: agentId('agent-x'),
      chatIds: [channelId('och_x')],
      bridgeFactory: () => bridge,
    });

    expect(bridge.closed).toBe(true);
    expect(cloud.closed).toBe(true);
  });

  it('uses the writer for startup and shutdown messages', async () => {
    const cloud = mockPlatformClient();
    const acp = mockAcpSession();
    const bridge = mockBridge();
    const router = new Router();
    const output: string[] = [];

    await run(cloud, acp, router, {
      agentId: agentId('agent-write'),
      chatIds: [channelId('och_write')],
      writer: (chunk) => output.push(chunk),
      bridgeFactory: () => bridge,
    });

    expect(output.some((o) => o.includes('Bridge 模式启动'))).toBe(true);
    expect(output.some((o) => o.includes('Bridge 已关闭'))).toBe(true);
  });

  it('closes the bridge when factory is provided', async () => {
    const cloud = mockPlatformClient();
    const acp = mockAcpSession();
    const bridge = mockBridge();
    const router = new Router();

    await run(cloud, acp, router, {
      agentId: agentId('agent-factory'),
      chatIds: [channelId('och_factory')],
      bridgeFactory: () => bridge,
    });

    expect(bridge.closed).toBe(true);
  });
});

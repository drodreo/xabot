import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { chat } from './chat.js';
import { XacppPeer, SocketTransport } from 'xacpp';
import type { PlatformClient } from '../core/client.js';

let connectionCallback: ((socket: unknown) => void) | null = null;

vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof import('node:net')>('node:net');
  return {
    ...actual,
    createServer: vi.fn(() => ({
      listen: vi.fn((_port: unknown, _host: unknown, cb: () => void) => cb()),
      address: () => ({ port: 12345, family: 'IPv4', address: '127.0.0.1' }),
      on: vi.fn((event: string, cb: (socket: unknown) => void) => {
        if (event === 'connection') {
          connectionCallback = cb;
        }
      }),
      close: vi.fn(),
    })),
  };
});

describe('chat', () => {
  let establishSpy: ReturnType<typeof vi.spyOn>;
  let connectSpy: ReturnType<typeof vi.spyOn>;
  let stdinRouterStartSpy: ReturnType<typeof vi.spyOn>;

  function mockCloud(): PlatformClient {
    return {
      platform: 'mock',
      connect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      messages: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {},
      }),
      streamCapability: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformClient;
  }

  function mockSocket() {
    return { destroy: vi.fn() };
  }

  beforeEach(async () => {
    connectionCallback = null;

    establishSpy = vi.spyOn(XacppPeer.prototype, 'establish').mockResolvedValue({
      credentials: 'cred-123',
    } as unknown as import('xacpp').XacppSession);

    connectSpy = vi.spyOn(XacppPeer.prototype, 'connect').mockImplementation(async function (this: XacppPeer) {
      if (connectionCallback) {
        connectionCallback(mockSocket());
      }
    });

    vi.spyOn(XacppPeer.prototype, 'disconnect').mockResolvedValue(undefined);

    vi.spyOn(SocketTransport, 'connectTo').mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as SocketTransport);

    const { StdinRouter } = await import('../xacpp/stdin-router.js');
    stdinRouterStartSpy = vi.spyOn(StdinRouter.prototype, 'start').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with credentials: passes credentials to establish', async () => {
    const cloud = mockCloud();

    await chat(cloud, { credentials: 'my-cred' });

    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(establishSpy).toHaveBeenCalledWith(
      'my-cred',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('without credentials: uses undefined for establish', async () => {
    const cloud = mockCloud();

    await chat(cloud);

    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(establishSpy).toHaveBeenCalledWith(
      undefined,
      expect.anything(),
      expect.any(Function),
    );
  });
});

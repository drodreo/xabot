import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { StdinRouter } from './stdin-router.js';

function fakeStdin(): Readable {
  return new Readable({ read() {} });
}

/** Push a line and wait for readline to emit the 'line' event. */
async function pushLine(stdin: Readable, line: string): Promise<void> {
  stdin.push(`${line}\n`);
  await new Promise<void>((r) => setImmediate(r));
}

describe('StdinRouter', () => {
  it('routes input to default channel by default', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = vi.fn();
    router.subscribe('default', handler);
    const startPromise = router.start();

    await pushLine(stdin, 'hello');
    expect(handler).toHaveBeenCalledWith('hello');

    router.close();
    await startPromise;
  });

  it('routes input to cmd_response after intercept()', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const defaultHandler = vi.fn();
    const cmdHandler = vi.fn();
    router.subscribe('default', defaultHandler);
    router.subscribe('cmd_response', cmdHandler);
    const startPromise = router.start();

    router.intercept();
    await pushLine(stdin, 'approve');
    expect(defaultHandler).not.toHaveBeenCalled();
    expect(cmdHandler).toHaveBeenCalledWith('approve');

    router.close();
    await startPromise;
  });

  it('routes back to default after release()', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const defaultHandler = vi.fn();
    const cmdHandler = vi.fn();
    router.subscribe('default', defaultHandler);
    router.subscribe('cmd_response', cmdHandler);
    const startPromise = router.start();

    router.intercept();
    await pushLine(stdin, 'during intercept');
    expect(cmdHandler).toHaveBeenCalledWith('during intercept');

    router.release();
    await pushLine(stdin, 'after release');
    expect(defaultHandler).toHaveBeenCalledWith('after release');

    router.close();
    await startPromise;
  });

  it('dispatches empty lines as empty string', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = vi.fn();
    router.subscribe('default', handler);
    const startPromise = router.start();

    await pushLine(stdin, '   ');
    expect(handler).toHaveBeenCalledWith('');

    router.close();
    await startPromise;
  });

  it('silently drops input when no subscriber is registered', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    // No subscribers registered
    const startPromise = router.start();

    // Should not throw
    await pushLine(stdin, 'orphan');

    router.close();
    await startPromise;
  });

  it('throws on duplicate start()', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    router.subscribe('default', vi.fn());
    const startPromise = router.start();

    await expect(router.start()).rejects.toThrow('StdinRouter already started');

    router.close();
    await startPromise;
  });

  it('stops dispatching after close()', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = vi.fn();
    router.subscribe('default', handler);
    const startPromise = router.start();

    router.close();
    await startPromise;

    await pushLine(stdin, 'after close');
    expect(handler).not.toHaveBeenCalled();
  });
});

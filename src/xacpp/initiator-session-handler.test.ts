import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { InitiatorSessionHandler } from './initiator-session-handler.js';
import { StdinRouter } from './stdin-router.js';

function fakeStdin(): Readable {
  return new Readable({ read() {} });
}

async function pushLine(stdin: Readable, line: string): Promise<void> {
  stdin.push(`${line}\n`);
  await new Promise<void>((r) => setImmediate(r));
}

describe('InitiatorSessionHandler', () => {
  it('last_activity: valid input returns activity_ready', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = new InitiatorSessionHandler(router);
    router.start();

    const responsePromise = handler.onCommand({ generic: { name: 'last_activity', arguments: {} } });
    await pushLine(stdin, 'my-activity-id');

    const response = await responsePromise;
    expect(response).toEqual({ kind: 'generic', name: 'activity_ready', data: { activity: 'my-activity-id', agent: 'chat' } });

    router.close();
  });

  it('last_activity: empty input returns activity_not_found', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = new InitiatorSessionHandler(router);
    router.start();

    const responsePromise = handler.onCommand({ generic: { name: 'last_activity', arguments: {} } });
    await pushLine(stdin, '   ');

    const response = await responsePromise;
    expect(response).toEqual({ kind: 'generic', name: 'activity_not_found', data: null });

    router.close();
  });

  it('compact_activity: returns acknowledge', async () => {
    const handler = new InitiatorSessionHandler(new StdinRouter(fakeStdin()));

    const response = await handler.onCommand({ generic: { name: 'compact_activity', arguments: { activity: 'act-1' } } });
    expect(response).toEqual({ kind: 'generic', name: 'acknowledge', data: null });
  });

  it('cancel_activity: returns acknowledge', async () => {
    const handler = new InitiatorSessionHandler(new StdinRouter(fakeStdin()));

    const response = await handler.onCommand({ generic: { name: 'cancel_activity', arguments: { activity: 'act-2' } } });
    expect(response).toEqual({ kind: 'generic', name: 'acknowledge', data: null });
  });

  it('last_activity: intercept before prompt, release after response', async () => {
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const interceptSpy = vi.spyOn(router, 'intercept');
    const releaseSpy = vi.spyOn(router, 'release');
    const handler = new InitiatorSessionHandler(router);
    router.start();

    const responsePromise = handler.onCommand({ generic: { name: 'last_activity', arguments: {} } });
    expect(interceptSpy).toHaveBeenCalledTimes(1);

    await pushLine(stdin, 'some-id');
    await responsePromise;

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    router.close();
  });
});

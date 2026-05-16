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
    const writer = vi.fn();
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = new InitiatorSessionHandler(writer, router);
    router.start();

    const responsePromise = handler.onCommand('last_activity');
    await pushLine(stdin, 'my-activity-id');

    const response = await responsePromise;
    expect(response).toEqual({ kind: 'activity_ready', activity: 'my-activity-id', agent: 'chat' });

    expect(writer).toHaveBeenCalledTimes(5);
    expect(writer).toHaveBeenNthCalledWith(1, '[chat] received last_activity command\n');
    expect(writer).toHaveBeenNthCalledWith(2, '[chat] last_activity → received\n');
    expect(writer).toHaveBeenNthCalledWith(3, '[chat] Resume previous activity? Enter activity ID (or press Enter for new):\n');
    expect(writer).toHaveBeenNthCalledWith(4, '[chat] resuming activity: my-activity-id\n');
    expect(writer).toHaveBeenNthCalledWith(5, '[chat] last_activity → activity_ready, agent=chat\n');

    router.close();
  });

  it('last_activity: empty input returns activity_not_found', async () => {
    const writer = vi.fn();
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const handler = new InitiatorSessionHandler(writer, router);
    router.start();

    const responsePromise = handler.onCommand('last_activity');
    await pushLine(stdin, '   ');

    const response = await responsePromise;
    expect(response).toEqual({ kind: 'activity_not_found' });

    expect(writer).toHaveBeenCalledTimes(5);
    expect(writer).toHaveBeenNthCalledWith(1, '[chat] received last_activity command\n');
    expect(writer).toHaveBeenNthCalledWith(2, '[chat] last_activity → received\n');
    expect(writer).toHaveBeenNthCalledWith(3, '[chat] Resume previous activity? Enter activity ID (or press Enter for new):\n');
    expect(writer).toHaveBeenNthCalledWith(4, '[chat] no activity ID provided, returning activity_not_found\n');
    expect(writer).toHaveBeenNthCalledWith(5, '[chat] last_activity → activity_not_found\n');

    router.close();
  });

  it('compact_activity: returns acknowledge and logs activity', async () => {
    const writer = vi.fn();
    const handler = new InitiatorSessionHandler(writer, new StdinRouter(fakeStdin()));

    const response = await handler.onCommand({ compact_activity: { activity: 'act-1' } });
    expect(response).toEqual({ kind: 'acknowledge' });
    expect(writer).toHaveBeenCalledWith('[chat] compact_activity [act-act-1]\n');
  });

  it('cancel_activity: returns acknowledge and logs activity', async () => {
    const writer = vi.fn();
    const handler = new InitiatorSessionHandler(writer, new StdinRouter(fakeStdin()));

    const response = await handler.onCommand({ cancel_activity: { activity: 'act-2' } });
    expect(response).toEqual({ kind: 'acknowledge' });
    expect(writer).toHaveBeenCalledWith('[chat] cancel_activity [act-act-2]\n');
  });

  it('last_activity: intercept before prompt, release after response', async () => {
    const writer = vi.fn();
    const stdin = fakeStdin();
    const router = new StdinRouter(stdin);
    const interceptSpy = vi.spyOn(router, 'intercept');
    const releaseSpy = vi.spyOn(router, 'release');
    const handler = new InitiatorSessionHandler(writer, router);
    router.start();

    const responsePromise = handler.onCommand('last_activity');
    expect(interceptSpy).toHaveBeenCalledTimes(1);

    await pushLine(stdin, 'some-id');
    await responsePromise;

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    router.close();
  });
});

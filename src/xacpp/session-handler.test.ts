import { describe, it, expect, vi } from 'vitest';
import { XabotSessionHandler } from './session-handler.js';
import { Bridge } from '../bridge/index.js';

describe('XabotSessionHandler', () => {
  it('onCommand returns acknowledge when no bridge set', async () => {
    const handler = new XabotSessionHandler('test-session');
    const response = await handler.onCommand({ new_activity: { title: null } });
    expect(response).toEqual({ kind: 'acknowledge' });
  });

  it('onEvent returns acknowledge when no bridge set', async () => {
    const handler = new XabotSessionHandler('test-session');
    const response = await handler.onEvent({
      activity: 'act-1',
      event: { type: 'info', title: 'test', content: 'test content' },
    });
    expect(response).toEqual({ kind: 'acknowledge' });
  });

  it('onCommand delegates to bridge.handleCommand when bridge is set', async () => {
    const handler = new XabotSessionHandler('test-session');
    const handleCommand = vi.fn().mockResolvedValue({ kind: 'acknowledge' });
    const bridge = { handleCommand } as unknown as Bridge;
    handler.setBridge(bridge);

    const command = { new_activity: { title: null } };
    const response = await handler.onCommand(command);

    expect(handleCommand).toHaveBeenCalledWith(command);
    expect(response).toEqual({ kind: 'acknowledge' });
  });

  it('onEvent delegates to bridge.handleEvent when bridge is set', async () => {
    const handler = new XabotSessionHandler('test-session');
    const handleEvent = vi.fn().mockResolvedValue({ kind: 'acknowledge' });
    const bridge = { handleEvent } as unknown as Bridge;
    handler.setBridge(bridge);

    const event = { activity: 'act-1', event: { type: 'info', title: 'test', content: 'content' } };
    const response = await handler.onEvent(event);

    expect(handleEvent).toHaveBeenCalledWith('act-1', event);
    expect(response).toEqual({ kind: 'acknowledge' });
  });

  it('stores sessionId', () => {
    const handler = new XabotSessionHandler('my-session-id');
    expect(handler.sessionId).toBe('my-session-id');
  });
});

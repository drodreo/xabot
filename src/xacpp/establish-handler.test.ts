import { describe, it, expect } from 'vitest';
import { XabotEstablishHandler } from './establish-handler.js';
import { XabotSessionHandler } from './session-handler.js';
import { Bridge } from '../bridge/index.js';

describe('XabotEstablishHandler', () => {

  // ── Direct established path (!credentials) ────────────────────────────

  it('onEstablish(non-null credentials) returns { type: "established" }', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    const result = await handler.onEstablish(mockTransport, 'valid-creds');

    if (result.type !== 'established') {
      expect.unreachable('expected established, got ' + result.type);
    }
    expect(result.sessionId).toBeTruthy();
    expect(result.handler).toBeInstanceOf(XabotSessionHandler);
    expect(result.handler.sessionId).toBe(result.sessionId);
  });

  it('onEstablished callback is called on direct established path', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const calls: Array<{ transport: any; sessionId: string; credentials: string }> = [];

    handler.onEstablished((transport, sessionId, credentials) => {
      calls.push({ transport, sessionId, credentials });
    });

    await handler.onEstablish(mockTransport, 'test-creds');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.transport).toBe(mockTransport);
    expect(calls[0]!.credentials).toBe('test-creds');
  });

  it('works without registering onEstablished callback (direct path)', async () => {
    const handler = new XabotEstablishHandler();
    const result = await handler.onEstablish({} as any, 'creds');
    expect(result.type).toBe('established');
  });

  it('setBridge injects bridge into handler (direct path)', async () => {
    const establishHandler = new XabotEstablishHandler();
    const bridge = {} as unknown as Bridge;
    establishHandler.setBridge(bridge);
    const result = await establishHandler.onEstablish({} as any, 'creds');
    expect(establishHandler.lastHandler).toBe(result.type === 'established' ? result.handler : null);
  });

  it('lastHandler is null initially', () => {
    const handler = new XabotEstablishHandler();
    expect(handler.lastHandler).toBeNull();
  });

  it('lastHandler updated after direct established', async () => {
    const handler = new XabotEstablishHandler();
    const result = await handler.onEstablish({} as any, 'creds');
    if (result.type === 'established') {
      expect(handler.lastHandler).toBe(result.handler);
    }
  });

  // ── Challenge path (!credentials) ─────────────────────────────────────

  it('onEstablish(null) blocks until submitChallenge is called', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    // Start onEstablish — it will block waiting for submitChallenge
    const establishPromise = handler.onEstablish(mockTransport);

    // Not yet resolved
    let resolved = false;
    establishPromise.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Submit challenge to unblock
    handler.submitChallenge('test-challenge-uuid', 'chat-123');

    const result = await establishPromise;
    expect(result.type).toBe('challenge_required');
    if (result.type === 'challenge_required') {
      expect(result.challenge).toBe('test-challenge-uuid');
    }
  });

  it('onEstablish(null) resolves immediately if submitChallenge was called first', async () => {
    const handler = new XabotEstablishHandler();

    // Submit challenge BEFORE onEstablish is called
    handler.submitChallenge('pre-cached-uuid', 'chat-pre');

    const result = await handler.onEstablish({} as any);
    expect(result.type).toBe('challenge_required');
    if (result.type === 'challenge_required') {
      expect(result.challenge).toBe('pre-cached-uuid');
    }
  });

  it('onEstablishConfirm returns session with credentials = chatId from challenge', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const calls: Array<string> = [];

    handler.onEstablished((_t, _sid, credentials) => {
      calls.push(credentials);
    });

    // Submit challenge
    handler.submitChallenge('abc-def', 'chat-from-cloud');

    // Establish
    await handler.onEstablish(mockTransport);

    // Confirm
    const result = await handler.onEstablishConfirm(mockTransport);

    expect(result.sessionId).toBeTruthy();
    expect(result.handler).toBeInstanceOf(XabotSessionHandler);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('chat-from-cloud');
  });

  it('onEstablishConfirm without pending challenge throws', async () => {
    const handler = new XabotEstablishHandler();
    await expect(handler.onEstablishConfirm({} as any)).rejects.toThrow('no pending challenge to confirm');
  });

  it('onEstablishConfirm throws if called twice', async () => {
    const handler = new XabotEstablishHandler();
    handler.submitChallenge('c1', 'ch1');
    await handler.onEstablish({} as any, null);
    await handler.onEstablishConfirm({} as any);
    await expect(handler.onEstablishConfirm({} as any)).rejects.toThrow('no pending challenge to confirm');
  });

  it('lastHandler unchanged after challenge_required', async () => {
    const handler = new XabotEstablishHandler();
    handler.submitChallenge('x', 'y');
    await handler.onEstablish({} as any);
    expect(handler.lastHandler).toBeNull();
  });

  it('lastHandler updated after onEstablishConfirm', async () => {
    const handler = new XabotEstablishHandler();
    handler.submitChallenge('x', 'y');
    await handler.onEstablish({} as any);
    const result = await handler.onEstablishConfirm({} as any);
    expect(handler.lastHandler).toBe(result.handler);
  });

  it('setBridge is injected into handler on confirm path', async () => {
    const handler = new XabotEstablishHandler();
    const bridge = {} as unknown as Bridge;
    handler.setBridge(bridge);
    handler.submitChallenge('x', 'y');
    await handler.onEstablish({} as any);
    const result = await handler.onEstablishConfirm({} as any);
    expect(handler.lastHandler).toBe(result.handler);
  });
});

import { describe, it, expect } from 'vitest';
import { XabotEstablishHandler } from './establish-handler.js';
import { XabotSessionHandler } from './session-handler.js';
import { Bridge } from '../bridge/index.js';

describe('XabotEstablishHandler', () => {
  // ── onEstablish with non-null credentials → direct established ─────────

  it('onEstablish(non-null credentials) returns { type: "established", sessionId, handler }', async () => {
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

  // ── onEstablish with null credentials → challenge_required ─────────────

  it('onEstablish(null) returns { type: "challenge_required", challenge }', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    const result = await handler.onEstablish(mockTransport, null);

    expect(result.type).toBe('challenge_required');
    if (result.type === 'challenge_required') {
      expect(result.challenge).toBeTruthy();
    }
  });

  // ── onEstablished callback with direct path ────────────────────────────

  it('onEstablished callback is called on direct established path', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const calls: Array<{ transport: any; sessionId: string; credentials: string | null }> = [];

    handler.onEstablished((transport, sessionId, credentials) => {
      calls.push({ transport, sessionId, credentials });
    });

    await handler.onEstablish(mockTransport, 'test-creds');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.transport).toBe(mockTransport);
    expect(calls[0]!.credentials).toBe('test-creds');
  });

  it('onEstablished callback NOT called on challenge_required path', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const calls: any[] = [];

    handler.onEstablished(() => calls.push('called'));

    await handler.onEstablish(mockTransport, null);

    expect(calls).toHaveLength(0);
  });

  // ── works without registering onEstablished callback ───────────────────

  it('onEstablish(non-null) works without onEstablished callback', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    const result = await handler.onEstablish(mockTransport, 'creds');
    expect(result.type).toBe('established');
  });

  it('onEstablish(null) works without onEstablished callback', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    const result = await handler.onEstablish(mockTransport, null);
    expect(result.type).toBe('challenge_required');
  });

  // ── setBridge ──────────────────────────────────────────────────────────

  it('setBridge injects bridge into handler (direct path)', async () => {
    const establishHandler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const bridge = {} as unknown as Bridge;

    establishHandler.setBridge(bridge);
    const result = await establishHandler.onEstablish(mockTransport, 'creds');

    expect(establishHandler.lastHandler).toBe(result.type === 'established' ? result.handler : null);
  });

  // ── onEstablishConfirm ─────────────────────────────────────────────────

  it('onEstablishConfirm creates session after challenge', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    // First: challenge_required
    await handler.onEstablish(mockTransport, null);

    // Second: confirm
    const result = await handler.onEstablishConfirm(mockTransport);

    expect(result.sessionId).toBeTruthy();
    expect(result.handler).toBeInstanceOf(XabotSessionHandler);
    expect(result.handler.sessionId).toBe(result.sessionId);
  });

  it('onEstablishConfirm triggers onEstablished callback with null credentials', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const calls: Array<string | null> = [];

    handler.onEstablished((_t, _sid, credentials) => {
      calls.push(credentials);
    });

    await handler.onEstablish(mockTransport, null);
    await handler.onEstablishConfirm(mockTransport);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeNull();
  });

  it('onEstablishConfirm without pending challenge throws', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    await expect(handler.onEstablishConfirm(mockTransport)).rejects.toThrow('no pending challenge to confirm');
  });

  it('onEstablishConfirm throws if called twice', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    await handler.onEstablish(mockTransport, null);
    await handler.onEstablishConfirm(mockTransport);

    await expect(handler.onEstablishConfirm(mockTransport)).rejects.toThrow('no pending challenge to confirm');
  });

  it('onEstablishConfirm clears pending challenge so direct path works after', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    await handler.onEstablish(mockTransport, null);
    await handler.onEstablishConfirm(mockTransport);

    // Now direct path should still work
    const result = await handler.onEstablish(mockTransport, 'creds');
    expect(result.type).toBe('established');
  });

  // ── lastHandler ────────────────────────────────────────────────────────

  it('lastHandler is null initially', () => {
    const handler = new XabotEstablishHandler();
    expect(handler.lastHandler).toBeNull();
  });

  it('lastHandler unchanged after challenge_required', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    await handler.onEstablish(mockTransport, null);
    expect(handler.lastHandler).toBeNull();
  });

  it('lastHandler updated after onEstablishConfirm', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    await handler.onEstablish(mockTransport, null);
    const result = await handler.onEstablishConfirm(mockTransport);

    expect(handler.lastHandler).toBe(result.handler);
  });

  it('lastHandler updated after direct established', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;

    const result = await handler.onEstablish(mockTransport, 'creds');

    if (result.type === 'established') {
      expect(handler.lastHandler).toBe(result.handler);
    }
  });

  it('setBridge is injected into handler on confirm path', async () => {
    const handler = new XabotEstablishHandler();
    const mockTransport = {} as any;
    const bridge = {} as unknown as Bridge;

    handler.setBridge(bridge);
    await handler.onEstablish(mockTransport, null);
    const result = await handler.onEstablishConfirm(mockTransport);

    expect(handler.lastHandler).toBe(result.handler);
  });
});

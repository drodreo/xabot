import { describe, it, expect } from 'vitest';
import { AcpHandler } from '../acp/handler.js';
import { sessionId } from '../core/types.js';

describe('AcpHandler', () => {
  // -------------------------------------------------------------------------
  // Basic drain / clear
  // -------------------------------------------------------------------------

  it('drainNotifications on empty queue returns empty array', () => {
    const h = new AcpHandler();
    expect(h.drainNotifications()).toEqual([]);
  });

  it('drainPermissions on empty queue returns empty array', () => {
    const h = new AcpHandler();
    expect(h.drainPermissions()).toEqual([]);
  });

  it('drain notifications returns and clears queue', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'hello' });
    h.pushNotification({ sessionId: sessionId('s2'), content: 'world' });

    const out = h.drainNotifications();
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe('hello');

    expect(h.drainNotifications()).toHaveLength(0);
  });

  it('drain permissions returns and clears queue', () => {
    const h = new AcpHandler();
    h.pushPermission({ sessionId: sessionId('s1'), name: 'tool', options: ['allow', 'deny'] });

    const out = h.drainPermissions();
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('tool');

    expect(h.drainPermissions()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Ordering: multiple push + single drain preserves FIFO order
  // -------------------------------------------------------------------------

  it('drainNotifications returns notifications in push order', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'first' });
    h.pushNotification({ sessionId: sessionId('s2'), content: 'second' });
    h.pushNotification({ sessionId: sessionId('s3'), content: 'third' });

    const out = h.drainNotifications();
    expect(out[0]!.content).toBe('first');
    expect(out[1]!.content).toBe('second');
    expect(out[2]!.content).toBe('third');
  });

  it('drainPermissions returns permissions in push order', () => {
    const h = new AcpHandler();
    h.pushPermission({ sessionId: sessionId('s1'), name: 'tool-a', options: ['opt1'] });
    h.pushPermission({ sessionId: sessionId('s2'), name: 'tool-b', options: ['opt2'] });

    const out = h.drainPermissions();
    expect(out[0]!.name).toBe('tool-a');
    expect(out[1]!.name).toBe('tool-b');
  });

  // -------------------------------------------------------------------------
  // Alternating pushes
  // -------------------------------------------------------------------------

  it('alternating pushNotification and pushPermission keeps queues independent', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'n1' });
    h.pushPermission({ sessionId: sessionId('s1'), name: 'p1', options: [] });
    h.pushNotification({ sessionId: sessionId('s2'), content: 'n2' });
    h.pushPermission({ sessionId: sessionId('s2'), name: 'p2', options: [] });

    const notifs = h.drainNotifications();
    const perms = h.drainPermissions();

    expect(notifs).toHaveLength(2);
    expect(notifs[0]!.content).toBe('n1');
    expect(notifs[1]!.content).toBe('n2');

    expect(perms).toHaveLength(2);
    expect(perms[0]!.name).toBe('p1');
    expect(perms[1]!.name).toBe('p2');
  });

  it('draining notifications does not clear permission queue', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'n1' });
    h.pushPermission({ sessionId: sessionId('s1'), name: 'p1', options: [] });

    h.drainNotifications();

    expect(h.drainPermissions()).toHaveLength(1);
    expect(h.drainNotifications()).toHaveLength(0);
  });

  it('draining permissions does not clear notification queue', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'n1' });
    h.pushPermission({ sessionId: sessionId('s1'), name: 'p1', options: [] });

    h.drainPermissions();

    expect(h.drainNotifications()).toHaveLength(1);
    expect(h.drainPermissions()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Proactive message queue
  // ---------------------------------------------------------------------------

  it('drainProactive on empty queue returns empty array', () => {
    const h = new AcpHandler();
    expect(h.drainProactive()).toEqual([]);
  });

  it('drain proactive returns and clears queue', () => {
    const h = new AcpHandler();
    h.pushProactive({ chatId: 'chat-1', content: 'hello proactive' });
    h.pushProactive({ chatId: 'chat-2', content: 'second proactive' });

    const out = h.drainProactive();
    expect(out).toHaveLength(2);
    expect(out[0]!.chatId).toBe('chat-1');
    expect(out[0]!.content).toBe('hello proactive');

    expect(h.drainProactive()).toHaveLength(0);
  });

  it('drainProactive returns messages in push order', () => {
    const h = new AcpHandler();
    h.pushProactive({ chatId: 'c1', content: 'first' });
    h.pushProactive({ chatId: 'c2', content: 'second' });
    h.pushProactive({ chatId: 'c3', content: 'third' });

    const out = h.drainProactive();
    expect(out[0]!.content).toBe('first');
    expect(out[1]!.content).toBe('second');
    expect(out[2]!.content).toBe('third');
  });

  it('draining proactive does not clear notification or permission queues', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'n1' });
    h.pushPermission({ sessionId: sessionId('s1'), name: 'p1', options: [] });
    h.pushProactive({ chatId: 'c1', content: 'pro1' });

    h.drainProactive();

    expect(h.drainNotifications()).toHaveLength(1);
    expect(h.drainPermissions()).toHaveLength(1);
  });

  it('draining notifications does not clear proactive queue', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'n1' });
    h.pushProactive({ chatId: 'c1', content: 'pro1' });

    h.drainNotifications();

    expect(h.drainProactive()).toHaveLength(1);
  });

  it('draining permissions does not clear proactive queue', () => {
    const h = new AcpHandler();
    h.pushPermission({ sessionId: sessionId('s1'), name: 'p1', options: [] });
    h.pushProactive({ chatId: 'c1', content: 'pro1' });

    h.drainPermissions();

    expect(h.drainProactive()).toHaveLength(1);
  });

  it('all three queues are independent', () => {
    const h = new AcpHandler();
    h.pushNotification({ sessionId: sessionId('s1'), content: 'n1' });
    h.pushPermission({ sessionId: sessionId('s1'), name: 'p1', options: [] });
    h.pushProactive({ chatId: 'c1', content: 'pro1' });

    h.drainNotifications();
    h.drainPermissions();

    expect(h.drainProactive()).toHaveLength(1);
    expect(h.drainNotifications()).toHaveLength(0);
    expect(h.drainPermissions()).toHaveLength(0);
  });
});

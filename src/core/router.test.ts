import { describe, it, expect } from 'vitest';
import { Router } from '../core/router.js';
import { channelId, agentId } from '../core/types.js';

describe('Router', () => {
  it('register and resolve', () => {
    const r = new Router();
    const a = agentId('agent-1');
    const c1 = channelId('chat-1');
    const c2 = channelId('chat-2');
    r.register(a, [c1, c2]);

    expect(r.resolve(c1)).toBe(a);
    expect(r.resolve(c2)).toBe(a);
    expect(r.resolve(channelId('chat-x'))).toBeUndefined();
  });

  it('chats returns registered chat ids', () => {
    const r = new Router();
    const a = agentId('agent-1');
    const chats = [channelId('c1'), channelId('c2')];
    r.register(a, chats);

    expect(r.chats(a)).toEqual(chats);
    expect(r.chats(agentId('unknown'))).toEqual([]);
  });

  it('size returns total registered chats', () => {
    const r = new Router();
    r.register(agentId('a1'), [channelId('c1'), channelId('c2')]);
    r.register(agentId('a2'), [channelId('c3')]);

    expect(r.size).toBe(3);
  });

  it('overwrites previous registration for same agent', () => {
    const r = new Router();
    const a = agentId('a');
    r.register(a, [channelId('old')]);
    r.register(a, [channelId('new1'), channelId('new2')]);

    expect(r.chats(a)).toEqual([channelId('new1'), channelId('new2')]);
    expect(r.resolve(channelId('old'))).toBeUndefined();
    expect(r.resolve(channelId('new1'))).toBe(a);
  });

  // -------------------------------------------------------------------------
  // Additional tests — multi-agent isolation, size tracking, empty arrays
  // -------------------------------------------------------------------------

  it('multiple agents do not confuse resolve', () => {
    const r = new Router();
    const a1 = agentId('agent-1');
    const a2 = agentId('agent-2');
    const c1 = channelId('chat-a');
    const c2 = channelId('chat-b');
    const c3 = channelId('chat-c');

    r.register(a1, [c1, c2]);
    r.register(a2, [c3]);

    expect(r.resolve(c1)).toBe(a1);
    expect(r.resolve(c2)).toBe(a1);
    expect(r.resolve(c3)).toBe(a2);
    expect(r.resolve(channelId('chat-unknown'))).toBeUndefined();
  });

  it('size increases with each register call', () => {
    const r = new Router();
    expect(r.size).toBe(0);

    r.register(agentId('a1'), [channelId('c1')]);
    expect(r.size).toBe(1);

    r.register(agentId('a2'), [channelId('c2'), channelId('c3')]);
    expect(r.size).toBe(3);
  });

  it('re-register updates size correctly', () => {
    const r = new Router();
    const a = agentId('a1');
    r.register(a, [channelId('c1'), channelId('c2')]);
    expect(r.size).toBe(2);

    // re-register with fewer chats
    r.register(a, [channelId('c3')]);
    expect(r.size).toBe(1);

    // re-register with more chats
    r.register(a, [channelId('c4'), channelId('c5'), channelId('c6')]);
    expect(r.size).toBe(3);
  });

  it('registering empty chatIds array leaves size at 0', () => {
    const r = new Router();
    r.register(agentId('a1'), []);
    expect(r.size).toBe(0);
    expect(r.chats(agentId('a1'))).toEqual([]);
  });

  // P0: cross-agent chatId conflict — registering a2 with c1 evicts c1 from a1
  it('register(a2, [c1]) evicts c1 from a1', () => {
    const r = new Router();
    const a1 = agentId('agent-1');
    const a2 = agentId('agent-2');
    const c1 = channelId('chat-1');

    r.register(a1, [c1]);
    expect(r.resolve(c1)).toBe(a1);
    expect(r.chats(a1)).toEqual([c1]);

    r.register(a2, [c1]);
    expect(r.resolve(c1)).toBe(a2);
    expect(r.chats(a1)).toEqual([]); // a1 no longer owns c1
    expect(r.chats(a2)).toEqual([c1]);
  });

  // P2-4: duplicate chatIds within a single register call are deduplicated
  it('duplicate chatIds in a single register call are deduplicated', () => {
    const r = new Router();
    const a = agentId('a');
    const c1 = channelId('c1');
    const c2 = channelId('c2');

    r.register(a, [c1, c1, c2, c1]);

    // size should reflect unique chatIds only
    expect(r.size).toBe(2);
    expect(r.chats(a)).toEqual([c1, c2]);
  });

  it('registering multiple agents then overwriting one does not affect the other', () => {
    const r = new Router();
    const a1 = agentId('agent-1');
    const a2 = agentId('agent-2');

    r.register(a1, [channelId('c1')]);
    r.register(a2, [channelId('c2')]);
    expect(r.size).toBe(2);

    // overwrite a1
    r.register(a1, [channelId('c3'), channelId('c4')]);

    expect(r.size).toBe(3); // c1 removed, c3+c4 added
    expect(r.resolve(channelId('c1'))).toBeUndefined();
    expect(r.resolve(channelId('c2'))).toBe(a2);
    expect(r.resolve(channelId('c3'))).toBe(a1);
    expect(r.resolve(channelId('c4'))).toBe(a1);
  });
});

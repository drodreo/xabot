import { describe, it, expect } from 'vitest';
import { parseAcpArgs, AcpArgsSchema } from './schema.js';

describe('parseAcpArgs', () => {
  it('parses valid args', () => {
    const args = parseAcpArgs([
      '--platform', 'feishu',
      '--app-id', 'cli_abc',
      '--app-secret', 'secret123',
      '--agent-id', 'agent-1',
      '--chat-ids', 'chat1,chat2',
    ]);
    expect(args.platform).toBe('feishu');
    expect(args.appId).toBe('cli_abc');
    expect(args.appSecret).toBe('secret123');
    expect(args.agentId).toBe('agent-1');
    expect(args.chatIds).toEqual(['chat1', 'chat2']);
  });

  it('rejects missing platform', () => {
    expect(() => parseAcpArgs(['--app-id', 'x', '--app-secret', 'y', '--agent-id', 'z', '--chat-ids', 'a'])).toThrow();
  });

  it('rejects missing app-id', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-secret', 'y',
      '--agent-id', 'z', '--chat-ids', 'a',
    ])).toThrow();
  });

  it('rejects missing app-secret', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x',
      '--agent-id', 'z', '--chat-ids', 'a',
    ])).toThrow();
  });

  it('rejects missing agent-id', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x', '--app-secret', 'y',
      '--chat-ids', 'a',
    ])).toThrow();
  });

  it('rejects missing chat-ids', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x',
      '--app-secret', 'y', '--agent-id', 'z',
    ])).toThrow();
  });

  it('rejects empty chatIds', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x', '--app-secret', 'y',
      '--agent-id', 'z', '--chat-ids', '',
    ])).toThrow();
  });

  it('accepts wechat platform', () => {
    const args = parseAcpArgs([
      '--platform', 'wechat',
      '--app-id', 'x', '--app-secret', 'y',
      '--agent-id', 'z', '--chat-ids', 'c1',
    ]);
    expect(args.platform).toBe('wechat');
  });

  it('rejects platform not in feishu or wechat', () => {
    expect(() => parseAcpArgs([
      '--platform', 'slack',
      '--app-id', 'x', '--app-secret', 'y',
      '--agent-id', 'z', '--chat-ids', 'c1',
    ])).toThrow();
  });

  it('rejects empty string app-id', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', '',
      '--app-secret', 'y', '--agent-id', 'z',
      '--chat-ids', 'c1',
    ])).toThrow();
  });

  it('rejects empty string app-secret', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x',
      '--app-secret', '', '--agent-id', 'z',
      '--chat-ids', 'c1',
    ])).toThrow();
  });

  it('rejects empty string agent-id', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x',
      '--app-secret', 'y', '--agent-id', '',
      '--chat-ids', 'c1',
    ])).toThrow();
  });

  // P2-3: unknown flags throw
  it('throws on unknown flag', () => {
    expect(() => parseAcpArgs([
      '--platform', 'feishu',
      '--app-id', 'x',
      '--app-secret', 'y',
      '--agent-id', 'z',
      '--chat-ids', 'c1',
      '--unknown-flag', 'oops',
    ])).toThrow('Unknown flag: --unknown-flag');
  });

  it('parses multiple comma-separated chat-ids', () => {
    const args = parseAcpArgs([
      '--platform', 'feishu', '--app-id', 'x',
      '--app-secret', 'y', '--agent-id', 'z',
      '--chat-ids', 'chat1,chat2,chat3',
    ]);
    expect(args.chatIds).toEqual(['chat1', 'chat2', 'chat3']);
  });
});

import { describe, it, expect } from 'vitest';
import { parseDiscoverArgs } from './schema.js';

describe('parseDiscoverArgs', () => {
  it('parses valid args with default timeout', () => {
    const args = parseDiscoverArgs([
      '--platform', 'feishu',
      '--app-id', 'cli_abc',
      '--app-secret', 'secret123',
    ]);
    expect(args.platform).toBe('feishu');
    expect(args.appId).toBe('cli_abc');
    expect(args.appSecret).toBe('secret123');
    expect(args.timeoutMs).toBe(60000);
  });

  it('parses valid args with custom timeout', () => {
    const args = parseDiscoverArgs([
      '--platform', 'wechat',
      '--app-id', 'x',
      '--app-secret', 'y',
      '--timeout-ms', '5000',
    ]);
    expect(args.platform).toBe('wechat');
    expect(args.timeoutMs).toBe(5000);
  });

  it('rejects missing platform', () => {
    expect(() => parseDiscoverArgs(['--app-id', 'x', '--app-secret', 'y'])).toThrow();
  });

  it('rejects missing app-id', () => {
    expect(() => parseDiscoverArgs([
      '--platform', 'feishu', '--app-secret', 'y',
    ])).toThrow();
  });

  it('rejects missing app-secret', () => {
    expect(() => parseDiscoverArgs([
      '--platform', 'feishu', '--app-id', 'x',
    ])).toThrow();
  });

  it('rejects invalid timeout-ms', () => {
    expect(() => parseDiscoverArgs([
      '--platform', 'feishu', '--app-id', 'x',
      '--app-secret', 'y', '--timeout-ms', 'abc',
    ])).toThrow();
  });

  it('rejects unknown flag', () => {
    expect(() => parseDiscoverArgs([
      '--platform', 'feishu',
      '--app-id', 'x',
      '--app-secret', 'y',
      '--unknown', 'oops',
    ])).toThrow('Unknown flag: --unknown');
  });

  it('accepts wechat platform', () => {
    const args = parseDiscoverArgs([
      '--platform', 'wechat',
      '--app-id', 'x', '--app-secret', 'y',
    ]);
    expect(args.platform).toBe('wechat');
  });
});

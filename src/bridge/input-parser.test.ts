import { describe, it, expect } from 'vitest';
import { parseInput } from './input-parser.js';

describe('parseInput', () => {
  it('parses plain text as invoke', () => {
    expect(parseInput('hello world')).toEqual({ kind: 'invoke', text: 'hello world' });
  });

  it('parses /new without prompt', () => {
    expect(parseInput('/new')).toEqual({ kind: 'new' });
  });

  it('parses /new with prompt', () => {
    expect(parseInput('/new 你好')).toEqual({ kind: 'new', prompt: '你好' });
  });

  it('trims trailing space after /new prompt', () => {
    expect(parseInput('/new 你好 ')).toEqual({ kind: 'new', prompt: '你好' });
  });

  it('parses /compact', () => {
    expect(parseInput('/compact')).toEqual({ kind: 'compact' });
  });

  it('parses /cancel', () => {
    expect(parseInput('/cancel')).toEqual({ kind: 'cancel' });
  });

  it('parses /comapct typo as unknown_command', () => {
    expect(parseInput('/comapct')).toEqual({ kind: 'unknown_command', command: '/comapct' });
  });

  it('parses / as unknown_command', () => {
    expect(parseInput('/')).toEqual({ kind: 'unknown_command', command: '/' });
  });

  it('parses /hello as unknown_command', () => {
    expect(parseInput('/hello')).toEqual({ kind: 'unknown_command', command: '/hello' });
  });

  it('parses empty string as invoke', () => {
    expect(parseInput('')).toEqual({ kind: 'invoke', text: '' });
  });
});

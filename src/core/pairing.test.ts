import { describe, it, expect } from 'vitest';
import { generatePairingCode } from './pairing.js';

describe('generatePairingCode', () => {
  it('returns a string of the requested length', () => {
    expect(generatePairingCode(6)).toHaveLength(6);
    expect(generatePairingCode(8)).toHaveLength(8);
    expect(generatePairingCode(4)).toHaveLength(4);
  });

  it('returns only uppercase letters and digits', () => {
    const code = generatePairingCode(6);
    expect(code).toMatch(/^[A-Z0-9]+$/);
  });

  it('generates different codes on successive calls (randomness)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generatePairingCode(6));
    }
    // With 36^6 possibilities, 100 samples should all be unique with very high probability
    expect(codes.size).toBe(100);
  });

  it('defaults to length 6', () => {
    expect(generatePairingCode()).toHaveLength(6);
  });

  it('uses only characters from PAIRING_CHARSET', () => {
    const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode(10);
      for (const ch of code) {
        expect(CHARSET).toContain(ch);
      }
    }
  });

  it('throws when length is 0', () => {
    expect(() => generatePairingCode(0)).toThrow();
  });

  it('throws when length is negative', () => {
    expect(() => generatePairingCode(-1)).toThrow();
  });
});

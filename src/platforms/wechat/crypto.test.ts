import { describe, it, expect } from 'vitest';
import {
  aesEcbEncrypt,
  aesEcbDecrypt,
  generateAesKey,
  encodeAesKeyForMedia,
  encodeAesKeyForFile,
  parseAesKey,
} from './crypto.js';

describe('AES ECB round-trip', () => {
  it('encrypts and decrypts text data', () => {
    const key = generateAesKey();
    const plain = Buffer.from('hello world');
    const encrypted = aesEcbEncrypt(plain, key);
    const decrypted = aesEcbDecrypt(encrypted, key);
    expect(decrypted.toString()).toBe('hello world');
  });

  it('handles exact block size (16 bytes)', () => {
    const key = generateAesKey();
    const plain = Buffer.from('exactly sixteen!');
    const encrypted = aesEcbEncrypt(plain, key);
    const decrypted = aesEcbDecrypt(encrypted, key);
    expect(decrypted.toString()).toBe('exactly sixteen!');
  });

  it('handles multi-block data', () => {
    const key = generateAesKey();
    const plain = Buffer.from('this is a longer message that spans multiple blocks for AES-128-ECB encryption');
    const encrypted = aesEcbEncrypt(plain, key);
    const decrypted = aesEcbDecrypt(encrypted, key);
    expect(decrypted.toString()).toBe(plain.toString());
  });

  it('handles empty data (pads to one block)', () => {
    const key = generateAesKey();
    const plain = Buffer.alloc(0);
    const encrypted = aesEcbEncrypt(plain, key);
    const decrypted = aesEcbDecrypt(encrypted, key);
    expect(decrypted.length).toBe(0);
  });

  it('produces different ciphertext with different keys', () => {
    const key1 = generateAesKey();
    const key2 = generateAesKey();
    const plain = Buffer.from('same plaintext');
    const enc1 = aesEcbEncrypt(plain, key1);
    const enc2 = aesEcbEncrypt(plain, key2);
    expect(enc1.toString('hex')).not.toBe(enc2.toString('hex'));
  });

  it('throws on decrypt with wrong key', () => {
    const key1 = generateAesKey();
    const key2 = generateAesKey();
    const plain = Buffer.from('secret message here');
    const encrypted = aesEcbEncrypt(plain, key1);
    expect(() => aesEcbDecrypt(encrypted, key2)).toThrow();
  });
});

describe('AES key encoding', () => {
  it('media and file encodings are different', () => {
    const key = generateAesKey();
    const mediaEnc = encodeAesKeyForMedia(key);
    const fileEnc = encodeAesKeyForFile(key);
    expect(mediaEnc).not.toBe(fileEnc);
  });

  it('generateAesKey returns 16 bytes', () => {
    const key = generateAesKey();
    expect(key.length).toBe(16);
  });
});

describe('parseAesKey', () => {
  it('base64(raw 16 bytes) → returns 16 bytes directly', () => {
    const key = generateAesKey();
    const encoded = key.toString('base64');
    const parsed = parseAesKey(encoded);
    expect(parsed.toString('hex')).toBe(key.toString('hex'));
  });

  it('base64(hex string 32 chars) → hex decode to 16 bytes', () => {
    const key = generateAesKey();
    const hex = key.toString('hex');
    const encoded = Buffer.from(hex).toString('base64');
    const parsed = parseAesKey(encoded);
    expect(parsed.toString('hex')).toBe(key.toString('hex'));
  });

  it('non-16 non-32 bytes → throws', () => {
    const encoded = Buffer.from('short').toString('base64');
    expect(() => parseAesKey(encoded)).toThrow('Invalid AES key');
  });

  it('consistency with encode/decode round-trip', () => {
    const key = generateAesKey();
    // media encoding: base64(hex_string)
    const mediaEnc = encodeAesKeyForMedia(key);
    expect(parseAesKey(mediaEnc).toString('hex')).toBe(key.toString('hex'));
    // file encoding: base64(raw)
    const fileEnc = encodeAesKeyForFile(key);
    expect(parseAesKey(fileEnc).toString('hex')).toBe(key.toString('hex'));
  });
});

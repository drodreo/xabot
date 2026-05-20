import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-128-ECB encrypt (Node.js auto-padding handles PKCS7). */
export function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** AES-128-ECB decrypt (Node.js auto-padding handles PKCS7). */
export function aesEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Generate a 16-byte random AES key. */
export function generateAesKey(): Buffer {
  return randomBytes(16);
}

/** Image/video: base64(hex_string_of_16_bytes). */
export function encodeAesKeyForMedia(key: Buffer): string {
  return Buffer.from(key.toString('hex')).toString('base64');
}

/** File: base64(raw_16_bytes). */
export function encodeAesKeyForFile(key: Buffer): string {
  return key.toString('base64');
}

/**
 * Parse an AES key from its base64-encoded form.
 *
 * The iLink protocol uses two conventions:
 *   - base64(raw 16 bytes)  → decode directly
 *   - base64(hex string)    → base64 decode then hex decode
 *
 * We auto-detect by decoded length: 16 bytes = raw key, 32 bytes = hex-encoded key.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new Error(`Invalid AES key: base64-decoded to ${decoded.length} bytes, expected 16 or 32`);
}

/** Decrypt encrypted media buffer with the parsed AES key. */
export function decryptBuffer(encrypted: Buffer, aesKeyEncoded: string): Buffer {
  const key = parseAesKey(aesKeyEncoded);
  return aesEcbDecrypt(encrypted, key);
}

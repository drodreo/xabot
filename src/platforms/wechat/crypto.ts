import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const BLOCK_SIZE = 16;

/** PKCS7 pad — pad to next BLOCK_SIZE boundary. */
function pkcs7Pad(data: Buffer): Buffer {
  const padLen = BLOCK_SIZE - (data.length % BLOCK_SIZE);
  const padding = Buffer.alloc(padLen!, padLen!);
  return Buffer.concat([data, padding]);
}

/** PKCS7 unpad — strip trailing padding bytes. */
function pkcs7Unpad(data: Buffer): Buffer {
  const padLen = data[data.length - 1]!;
  if (padLen <= 0 || padLen > BLOCK_SIZE) {
    throw new Error('Invalid PKCS7 padding');
  }
  return data.subarray(0, data.length - padLen);
}

/** AES-128-ECB encrypt. */
export function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(pkcs7Pad(data)), cipher.final()]);
}

/** AES-128-ECB decrypt. */
export function aesEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return pkcs7Unpad(decrypted);
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

/** File: base64 → raw 16 bytes. */
export function decodeAesKeyForFile(encoded: string): Buffer {
  return Buffer.from(encoded, 'base64');
}

/** Image/video: base64 → hex string → raw 16 bytes. */
export function decodeAesKeyForMedia(encoded: string): Buffer {
  const hex = Buffer.from(encoded, 'base64').toString();
  return Buffer.from(hex, 'hex');
}

/**
 * Pairing code generation utilities.
 * Pure functions for generating and validating pairing codes.
 */

import { randomInt } from 'node:crypto';

const PAIRING_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CHARSET_SIZE = PAIRING_CHARSET.length; // 36

/**
 * Generate a random pairing code of the given length.
 * Uses crypto.randomInt for uniform distribution over the charset.
 */
export function generatePairingCode(length: number = 6): string {
  if (length <= 0) {
    throw new Error('Pairing code length must be a positive integer');
  }
  let result = '';
  for (let i = 0; i < length; i++) {
    result += PAIRING_CHARSET[randomInt(CHARSET_SIZE)]!;
  }
  return result;
}

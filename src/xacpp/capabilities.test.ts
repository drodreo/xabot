import { describe, it, expect } from 'vitest';
import { XABOT_CAPABILITIES } from './capabilities.js';

describe('XABOT_CAPABILITIES', () => {
  it('serializes without a fetchExt field (fetch support intentionally absent)', () => {
    // xabot runs same-host with the serve process and reads files via local
    // paths: fetchExt stays absent so the serve side fails fetch-family
    // commands locally without wire round-trips.
    const serialized = JSON.parse(JSON.stringify(XABOT_CAPABILITIES)) as Record<string, unknown>;
    expect('fetchExt' in serialized).toBe(false);
    expect(serialized.fetchExt).toBeUndefined();
  });
});

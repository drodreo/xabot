import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
import type { StreamCapability } from '../core/types.js';
import { messageId, StreamCapability as SC } from '../core/types.js';
import { health } from './health.js';

function healthyClient(): PlatformClient {
  return {
    platform: 'feishu',
    async connect() {},
    async send() {
      return messageId('id');
    },
    async *messages() {},
    streamCapability() {
      return SC.NonStreaming;
    },
    async healthCheck() {},
    async close() {},
  };
}

function unhealthyClient(reason = 'not connected'): PlatformClient {
  return {
    platform: 'wechat',
    async connect() {},
    async send() {
      return messageId('id');
    },
    async *messages() {},
    streamCapability() {
      return SC.NonStreaming;
    },
    async healthCheck() {
      throw new Error(reason);
    },
    async close() {},
  };
}

describe('health', () => {
  it('writes a success message when healthCheck passes', async () => {
    const output: string[] = [];
    await health(healthyClient(), { writer: (chunk) => output.push(chunk) });
    expect(output[0]).toMatch(/✅/);
    expect(output[0]).toMatch(/feishu/);
    expect(output[0]).toMatch(/连接正常/);
  });

  it('writes a failure message when healthCheck throws', async () => {
    const output: string[] = [];
    await expect(
      health(unhealthyClient('token expired'), { writer: (chunk) => output.push(chunk) }),
    ).rejects.toThrow('token expired');
    expect(output[0]).toMatch(/❌/);
    expect(output[0]).toMatch(/token expired/);
  });

  it('uses client.platform in the success message', async () => {
    const output: string[] = [];
    await health(healthyClient(), { writer: (chunk) => output.push(chunk) });
    expect(output[0]).toContain('feishu');
  });
});

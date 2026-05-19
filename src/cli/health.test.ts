import { describe, it, expect } from 'vitest';
import type { PlatformClient } from '../core/client.js';
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
  it('passes when healthCheck succeeds', async () => {
    await expect(health(healthyClient())).resolves.toBeUndefined();
  });

  it('throws when healthCheck fails', async () => {
    await expect(health(unhealthyClient('token expired'))).rejects.toThrow('token expired');
  });
});

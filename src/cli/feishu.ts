import { Command, Option } from 'commander';
import { FeishuClient, type FeishuClientConfig } from '../platforms/feishu/client.js';
import { health } from './health.js';
import { run } from './run.js';
import { chat, type ChatOptions } from './chat.js';
import { XabotEstablishHandler } from '../xacpp/establish-handler.js';
import { XacppPeer, XacppSession, StdioTransport } from 'xacpp';
import { Bridge } from '../bridge/index.js';

function createFeishuClient(appId: string, appSecret: string, logLevel?: string): FeishuClient {
  const cfg: FeishuClientConfig = { appId, appSecret };
  if (logLevel) cfg.logLevel = logLevel as 'info' | 'debug' | 'trace';
  return new FeishuClient(cfg);
}

export function registerFeishu(program: Command): void {
  const feishu = program
    .command('feishu')
    .description('Feishu (Lark) platform commands')
    .addOption(new Option('--app-id <id>', 'Feishu App ID').makeOptionMandatory(true))
    .addOption(new Option('--app-secret <secret>', 'Feishu App Secret').makeOptionMandatory(true))
    .addOption(new Option('--log-level <level>', 'Log level').choices(['info', 'debug', 'trace']).default('info'));

  feishu
    .command('health')
    .description('Verify credentials and connection health')
    .action(async () => {
      const { appId, appSecret, logLevel } = feishu.opts();
      const client = createFeishuClient(appId, appSecret, logLevel);
      await client.connect();
      await health(client);
      await client.close();
    });

  feishu
    .command('run')
    .description('Start Bridge mode with SIGINT/SIGTERM graceful shutdown')
    .action(async () => {
      const { appId, appSecret, logLevel } = feishu.opts();
      const cloud = createFeishuClient(appId, appSecret, logLevel);
      await cloud.connect();

      const transport = new StdioTransport(process.stdout, process.stdin);
      const establishHandler = new XabotEstablishHandler();
      const peer = new XacppPeer(transport, establishHandler);

      const bridge = new Bridge(cloud, transport);
      establishHandler.setBridge(bridge);
      bridge.setEstablishHandler(establishHandler);

      establishHandler.onEstablished((_t, sessionId, credentials) => {
        const session = new XacppSession(transport, sessionId, credentials);
        bridge.setSession(session);
      });

      await peer.connect();
      bridge.markEstablished();

      await run(bridge, peer, {});
    });

  feishu
    .command('chat')
    .option('--credentials <credentials>', 'Reuse existing session credentials (skip challenge)')
    .description('Interactive chat: Establish handshake + bidirectional messaging with Agent')
    .action(async (opts) => {
      const { appId, appSecret, logLevel } = feishu.opts();
      const cloud = createFeishuClient(appId, appSecret, logLevel);
      await cloud.connect();
      const chatOpts: ChatOptions = {};
      if (opts.credentials) {
        chatOpts.credentials = opts.credentials;
      }
      await chat(cloud, chatOpts);
    });
}

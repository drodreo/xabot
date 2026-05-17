import { Command } from 'commander';
import { WechatClient, type WechatConfig } from '../platforms/wechat/client.js';
import { login } from '../platforms/wechat/login.js';
import { health } from './health.js';
import { run } from './run.js';
import { chat } from './chat.js';
import { XabotEstablishHandler } from '../xacpp/establish-handler.js';
import { XacppPeer, XacppSession, StdioTransport } from 'xacpp';
import { Bridge } from '../bridge/index.js';
export function registerWechat(program: Command): void {
  const wechat = program
    .command('wechat')
    .description('WeChat (iLink Bot) platform commands');

  wechat
    .command('health')
    .requiredOption('--token <token>', 'WeChat iLink Bot token')
    .option('--base-url <url>', 'API base URL (default: https://ilinkai.weixin.qq.com)')
    .description('Verify credentials and connection health')
    .action(async (opts) => {
      const client = new WechatClient({ token: opts.token, baseUrl: opts.baseUrl });
      await client.connect();
      await health(client);
      await client.close();
    });

  wechat
    .command('run')
    .description('Start Bridge mode with SIGINT/SIGTERM graceful shutdown')
    .action(async () => {
      const transport = new StdioTransport(process.stdout, process.stdin);
      const establishHandler = new XabotEstablishHandler();

      const bridge = new Bridge(transport);
      establishHandler.setBridge(bridge);
      bridge.setEstablishHandler(establishHandler);

      establishHandler.setLoginFn(() => login());
      establishHandler.setEnsureCloudFn(async (token, baseUrl) => {
        const cfg: WechatConfig = { token };
        if (baseUrl) cfg.baseUrl = baseUrl;
        // renewToken only swaps the internal token; the client instance stays the same,
        // so bridge.replaceCloud() is not needed here.
        cfg.onTokenExpired = () => login().then((r) => r.token);
        const client = new WechatClient(cfg);
        await client.connect();
        bridge.replaceCloud(client);
      });

      establishHandler.onEstablished((_t, sessionId, credentials) => {
        const session = new XacppSession(transport, sessionId, credentials);
        bridge.setSession(session);
        bridge.markEstablished();
      });

      const peer = new XacppPeer(transport, establishHandler);
      bridge.run();
      await peer.connect();

      await run(bridge, peer, {});
    });

  wechat
    .command('chat')
    .option('--credentials <credentials>', 'Reuse existing session credentials (skip challenge)')
    .description('Interactive chat: Establish handshake + bidirectional messaging with Agent')
    .action(async (opts) => {
      const chatOpts: import('./chat.js').ChatOptions = {
        writer: (c) => process.stderr.write(c),
        loginFn: () => login(),
        cloudFactory: async (token, baseUrl) => {
          const cfg: WechatConfig = { token };
          if (baseUrl) cfg.baseUrl = baseUrl;
          cfg.onTokenExpired = () => login().then((r) => r.token);
          const client = new WechatClient(cfg);
          await client.connect();
          return client;
        },
      };
      if (opts.credentials) {
        chatOpts.credentials = opts.credentials;
      }
      await chat(undefined, chatOpts);
    });
}

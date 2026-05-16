import { Command } from 'commander';
import { WechatClient, type WechatConfig } from '../platforms/wechat/client.js';
import { login } from '../platforms/wechat/login.js';
import { listen } from './listen.js';
import { send } from './send.js';
import { health } from './health.js';
import { run } from './run.js';
import { chat, type ChatOptions } from './chat.js';
import { channelId } from '../core/types.js';
import { XabotEstablishHandler } from '../xacpp/establish-handler.js';
import { XacppPeer, XacppSession, StdioTransport } from 'xacpp';
import { Bridge } from '../bridge/index.js';

function createWechatClient(token: string, baseUrl?: string): WechatClient {
  const cfg: WechatConfig = { token };
  if (baseUrl) cfg.baseUrl = baseUrl;
  return new WechatClient(cfg);
}

export function registerWechat(program: Command): void {
  const wechat = program
    .command('wechat')
    .description('WeChat (iLink Bot) platform commands');

  wechat
    .command('login')
    .description('Login via QR code scan, outputs { token, baseUrl } to stdout')
    .action(async () => {
      const result = await login();
      process.stdout.write(JSON.stringify(result) + '\n');
    });

  wechat
    .command('listen')
    .requiredOption('--token <token>', 'WeChat iLink Bot token')
    .option('--base-url <url>', 'API base URL (default: https://ilinkai.weixin.qq.com)')
    .requiredOption('--chat-id <id>', 'Chat ID for bidirectional messaging')
    .description('Interactive debug: relay stdin to chatId, print incoming messages to stderr')
    .action(async (opts) => {
      const client = createWechatClient(opts.token, opts.baseUrl);
      await client.connect();
      await listen(client, { chatId: channelId(opts.chatId) });
    });

  wechat
    .command('send')
    .requiredOption('--token <token>', 'WeChat iLink Bot token')
    .option('--base-url <url>', 'API base URL (default: https://ilinkai.weixin.qq.com)')
    .argument('<chatId>', 'Target chat ID')
    .argument('<message...>', 'Message text')
    .description('Send a text message to the specified chatId')
    .action(async (chatId: string, message: string[], opts: { token: string; baseUrl?: string }) => {
      const client = createWechatClient(opts.token, opts.baseUrl);
      await client.connect();
      await send(client, message.join(' '), { chatId: channelId(chatId) });
      await client.close();
    });

  wechat
    .command('health')
    .requiredOption('--token <token>', 'WeChat iLink Bot token')
    .option('--base-url <url>', 'API base URL (default: https://ilinkai.weixin.qq.com)')
    .description('Verify credentials and connection health')
    .action(async (opts) => {
      const client = createWechatClient(opts.token, opts.baseUrl);
      await client.connect();
      await health(client);
      await client.close();
    });

  wechat
    .command('run')
    .requiredOption('--token <token>', 'WeChat iLink Bot token')
    .option('--base-url <url>', 'API base URL (default: https://ilinkai.weixin.qq.com)')
    .description('Start Bridge mode with SIGINT/SIGTERM graceful shutdown')
    .action(async (opts) => {
      const cloud = createWechatClient(opts.token, opts.baseUrl);
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

  wechat
    .command('chat')
    .requiredOption('--token <token>', 'WeChat iLink Bot token')
    .option('--base-url <url>', 'API base URL (default: https://ilinkai.weixin.qq.com)')
    .option('--credentials <credentials>', 'Reuse existing session credentials (skip challenge)')
    .description('Interactive chat: Establish handshake + bidirectional messaging with Agent')
    .action(async (opts) => {
      const cloud = createWechatClient(opts.token, opts.baseUrl);
      await cloud.connect();
      const chatOpts: ChatOptions = {};
      if (opts.credentials) {
        chatOpts.credentials = opts.credentials;
      }
      await chat(cloud, chatOpts);
    });
}

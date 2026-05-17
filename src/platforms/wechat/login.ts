import { exec } from 'node:child_process';
import process from 'node:process';

export interface LoginResult {
  token: string;
  baseUrl: string;
}

export interface LoginOptions {
  /** 输出 writer，默认 process.stderr.write */
  writer?: (chunk: string) => void;
  /** 打开 URL，默认调用系统浏览器 */
  openUrl?: (url: string) => void;
}

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const POLL_INTERVAL_MS = 2_000;

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRCodeStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

function defaultOpenUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

async function getQRCode(): Promise<QRCodeResponse> {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`getQRCode failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<QRCodeResponse>;
}

async function pollQRCodeStatus(qrcode: string): Promise<QRCodeStatusResponse> {
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`pollQRCodeStatus failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<QRCodeStatusResponse>;
}

/**
 * 执行扫码登录。
 * 1. 获取二维码
 * 2. 自动打开浏览器
 * 3. 轮询扫码状态
 * 4. confirmed 后返回 { token, baseUrl }
 */
export async function login(options?: LoginOptions): Promise<LoginResult> {
  const writer = options?.writer ?? ((chunk: string) => process.stderr.write(chunk));
  const open = options?.openUrl ?? defaultOpenUrl;

  const { qrcode, qrcode_img_content } = await getQRCode();

  writer('请使用微信扫描二维码登录\n');
  open(qrcode_img_content);
  writer('等待扫码中...\n');

  let scanned = false;
  while (true) {
    const status = await pollQRCodeStatus(qrcode);
    if (status.status === 'confirmed') {
      if (!status.bot_token) {
        throw new Error('Login confirmed but no bot_token returned');
      }
      writer('登录成功！请在微信输入配对码完成配对\n');
      return {
        token: status.bot_token,
        baseUrl: status.baseurl ?? BASE_URL,
      };
    }

    if (status.status === 'expired') {
      throw new Error('QR code expired, please try again');
    }

    if (status.status === 'scaned' && !scanned) {
      scanned = true;
      writer('已扫码，请在手机上确认...\n');
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

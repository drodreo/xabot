import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { login, type LoginOptions } from './login.js';

const mockFetch = vi.fn<(...args: any[]) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn((_input: string, _opts: unknown, callback: (qr: string) => void) => {
      callback('ASCII_QR_CODE');
    }),
  },
}));

function makeJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe('login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // image mode
  // --------------------------------------------------------------------------

  describe('image mode', () => {
    it('gets QR code, outputs URL, polls confirmed, returns { token, baseUrl }', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_abc',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockResolvedValueOnce(makeJsonResponse({
          status: 'confirmed',
          bot_token: 'bot_tok_123',
          baseurl: 'https://custom.weixin.qq.com',
        }));

      const output: string[] = [];
      const opts: LoginOptions = { qrType: 'image', writer: (c) => output.push(c) };
      const result = await login(opts);

      expect(result).toEqual({ token: 'bot_tok_123', baseUrl: 'https://custom.weixin.qq.com' });
      expect(output.some((s) => s.includes('https://img.url/qr.png'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // text mode
  // --------------------------------------------------------------------------

  describe('text mode', () => {
    it('renders ASCII QR and returns result on confirmed', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_def',
          qrcode_img_content: 'https://img.url/qr2.png',
        }))
        .mockResolvedValueOnce(makeJsonResponse({
          status: 'confirmed',
          bot_token: 'bot_tok_456',
          baseurl: 'https://ilinkai.weixin.qq.com',
        }));

      const output: string[] = [];
      const opts: LoginOptions = { qrType: 'text', writer: (c) => output.push(c) };
      const result = await login(opts);

      expect(result.token).toBe('bot_tok_456');
      expect(output.some((s) => s.includes('请使用微信扫描上方二维码登录'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // expired
  // --------------------------------------------------------------------------

  describe('expired', () => {
    it('throws when QR code expires', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_exp',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockResolvedValueOnce(makeJsonResponse({ status: 'expired' }));

      const opts: LoginOptions = { qrType: 'image' };
      await expect(login(opts)).rejects.toThrow('QR code expired');
    });
  });

  // --------------------------------------------------------------------------
  // baseUrl fallback
  // --------------------------------------------------------------------------

  describe('baseUrl fallback', () => {
    it('defaults to https://ilinkai.weixin.qq.com when baseurl omitted', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_no_base',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockResolvedValueOnce(makeJsonResponse({
          status: 'confirmed',
          bot_token: 'tok_789',
        }));

      const result = await login({ qrType: 'image' });
      expect(result.baseUrl).toBe('https://ilinkai.weixin.qq.com');
    });
  });

  // --------------------------------------------------------------------------
  // baseUrl dynamic
  // --------------------------------------------------------------------------

  describe('baseUrl dynamic', () => {
    it('uses returned baseurl when present', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_custom',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockResolvedValueOnce(makeJsonResponse({
          status: 'confirmed',
          bot_token: 'tok_abc',
          baseurl: 'https://weixin.qq.com',
        }));

      const result = await login({ qrType: 'image' });
      expect(result.baseUrl).toBe('https://weixin.qq.com');
    });
  });

  // --------------------------------------------------------------------------
  // status transitions
  // --------------------------------------------------------------------------

  describe('status transitions', () => {
    it('wait -> scaned -> confirmed', async () => {
      vi.useFakeTimers();

      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_multi',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockResolvedValueOnce(makeJsonResponse({ status: 'wait' }))
        .mockResolvedValueOnce(makeJsonResponse({ status: 'scaned' }))
        .mockResolvedValueOnce(makeJsonResponse({
          status: 'confirmed',
          bot_token: 'tok_multi',
        }));

      const output: string[] = [];
      const opts: LoginOptions = { qrType: 'image', writer: (c) => output.push(c) };
      const promise = login(opts);

      await vi.advanceTimersByTimeAsync(4_000);
      const result = await promise;

      expect(result.token).toBe('tok_multi');
      expect(output.some((s) => s.includes('已扫码，等待确认'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // network error
  // --------------------------------------------------------------------------

  describe('network error', () => {
    it('throws when get_bot_qrcode fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const opts: LoginOptions = { qrType: 'image' };
      await expect(login(opts)).rejects.toThrow('Network error');
    });

    it('throws when get_qrcode_status fails', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_err',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockRejectedValueOnce(new Error('Status poll error'));

      const opts: LoginOptions = { qrType: 'image' };
      await expect(login(opts)).rejects.toThrow('Status poll error');
    });
  });
});

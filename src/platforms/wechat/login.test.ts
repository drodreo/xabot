import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { login } from './login.js';

const mockFetch = vi.fn<(...args: any[]) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

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
  // 正常流程
  // --------------------------------------------------------------------------

  it('gets QR code, prompts, opens URL, polls confirmed, returns { token, baseUrl }', async () => {
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
    const openUrl = vi.fn();
    const readline = vi.fn().mockResolvedValue(undefined);

    const result = await login({
      writer: (c) => output.push(c),
      readline,
      openUrl,
    });

    expect(result).toEqual({ token: 'bot_tok_123', baseUrl: 'https://custom.weixin.qq.com' });
    expect(readline).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://img.url/qr.png');
    expect(output.some((s) => s.includes('按回车键在浏览器中打开二维码'))).toBe(true);
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

      await expect(
        login({ readline: vi.fn().mockResolvedValue(undefined), openUrl: vi.fn() }),
      ).rejects.toThrow('QR code expired');
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

      const result = await login({
        readline: vi.fn().mockResolvedValue(undefined),
        openUrl: vi.fn(),
      });
      expect(result.baseUrl).toBe('https://weixin.qq.com');
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

      const result = await login({
        readline: vi.fn().mockResolvedValue(undefined),
        openUrl: vi.fn(),
      });
      expect(result.baseUrl).toBe('https://ilinkai.weixin.qq.com');
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
      const promise = login({
        writer: (c) => output.push(c),
        readline: vi.fn().mockResolvedValue(undefined),
        openUrl: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(4_000);
      const result = await promise;

      expect(result.token).toBe('tok_multi');
      expect(output.some((s) => s.includes('已扫码，请在手机上确认'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // network error
  // --------------------------------------------------------------------------

  describe('network error', () => {
    it('throws when get_bot_qrcode fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        login({ readline: vi.fn().mockResolvedValue(undefined), openUrl: vi.fn() }),
      ).rejects.toThrow('Network error');
    });

    it('throws when get_qrcode_status fails', async () => {
      mockFetch
        .mockResolvedValueOnce(makeJsonResponse({
          qrcode: 'qr_err',
          qrcode_img_content: 'https://img.url/qr.png',
        }))
        .mockRejectedValueOnce(new Error('Status poll error'));

      await expect(
        login({ readline: vi.fn().mockResolvedValue(undefined), openUrl: vi.fn() }),
      ).rejects.toThrow('Status poll error');
    });
  });
});

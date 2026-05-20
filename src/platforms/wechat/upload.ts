import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '../../core/logger.js';
const log = createLogger('WechatUpload');
import {
  aesEcbEncrypt,
  aesEcbDecrypt,
  generateAesKey,
  encodeAesKeyForMedia,
  encodeAesKeyForFile,
} from './crypto.js';

export interface WechatUploadResult {
  encryptQueryParam: string;
  aesKey: string;
  encryptType: number;
  encryptedSize: number;
  rawMd5: string;
  rawSize: number;
}

function makeHeaders(token: string, xWechatUin: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': xWechatUin,
  };
}

const MEDIA_TYPE_NUM: Record<string, number> = {
  image: 1,
  video: 2,
  file: 3,
  audio: 4,
};

export async function uploadMedia(
  baseUrl: string,
  token: string,
  xWechatUin: string,
  filePath: string,
  mediaType: string,
  toUserId: string,
): Promise<WechatUploadResult> {
  const data = await readFile(filePath);
  const md5 = createHash('md5').update(data).digest('hex');
  const key = generateAesKey();

  const aesKeyEncoded = encodeAesKeyForMedia(key);
  const aesKeyHex = key.toString('hex');
  const encryptedSize = Math.ceil((data.length + 1) / 16) * 16;
  const filekey = randomBytes(16).toString('hex');
  const mediaTypeNum = MEDIA_TYPE_NUM[mediaType] ?? 3;

  // Step 1: get upload URL
  const uploadUrlRes = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: makeHeaders(token, xWechatUin),
    body: JSON.stringify({
      filekey,
      media_type: mediaTypeNum,
      to_user_id: toUserId,
      rawsize: data.length,
      rawfilemd5: md5,
      filesize: encryptedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: '2.0.0' },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!uploadUrlRes.ok) {
    throw new Error(`WeChat getuploadurl failed: HTTP ${uploadUrlRes.status}`);
  }

  const uploadUrlData = (await uploadUrlRes.json()) as {
    ret?: number;
    errcode?: number;
    upload_param?: string;
    thumb_upload_param?: string;
  };

  log.debug('getuploadurl OK: type=%s size=%d', mediaType, data.length);

  if (uploadUrlData.ret !== undefined && uploadUrlData.ret !== 0) {
    throw new Error(`WeChat getuploadurl failed: ret=${uploadUrlData.ret}, errcode=${uploadUrlData.errcode}`);
  }

  const uploadParam = uploadUrlData.upload_param;
  if (!uploadParam) {
    throw new Error('WeChat getuploadurl returned no upload_param');
  }

  // Step 2: encrypt and upload
  const encrypted = aesEcbEncrypt(data, key);

  const cdnBaseUrl = 'https://novac2c.cdn.weixin.qq.com/c2c';
  const uploadUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${filekey}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encrypted,
    signal: AbortSignal.timeout(60_000),
  });

  if (!uploadRes.ok) {
    throw new Error(`WeChat upload failed: HTTP ${uploadRes.status}`);
  }

  const encryptQueryParam = uploadRes.headers.get('x-encrypted-param') ?? '';
  if (!encryptQueryParam) {
    throw new Error('WeChat upload failed: missing x-encrypted-param header');
  }

  log.debug('upload complete: encryptQueryParam=%s...', encryptQueryParam.slice(0, 16));

  return {
    encryptQueryParam,
    aesKey: aesKeyEncoded,
    encryptType: 1,
    encryptedSize,
    rawMd5: md5,
    rawSize: data.length,
  };
}



import { createHash } from 'node:crypto';
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
  decodeAesKeyForFile,
  decodeAesKeyForMedia,
} from './crypto.js';

export interface WechatUploadResult {
  encryptQueryParam: string;
  aesKey: string;
  encryptType: number;
}

function makeHeaders(token: string, xWechatUin: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': xWechatUin,
  };
}

export async function uploadMedia(
  baseUrl: string,
  token: string,
  xWechatUin: string,
  filePath: string,
  mediaType: string,
): Promise<WechatUploadResult> {
  const data = await readFile(filePath);
  const md5 = createHash('md5').update(data).digest('hex');
  const key = generateAesKey();

  // Select encoding by media type
  const isMedia = mediaType === 'image' || mediaType === 'video';
  const aesKeyEncoded = isMedia ? encodeAesKeyForMedia(key) : encodeAesKeyForFile(key);
  const aesKeyHex = key.toString('hex');

  // Step 1: get upload URL
  const uploadUrlRes = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: makeHeaders(token, xWechatUin),
    body: JSON.stringify({
      media_type: mediaType.toUpperCase(),
      rawsize: data.length,
      md5,
      filesize: data.length,
      aes_key: aesKeyHex,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!uploadUrlRes.ok) {
    throw new Error(`WeChat getuploadurl failed: HTTP ${uploadUrlRes.status}`);
  }

  const uploadUrlData = (await uploadUrlRes.json()) as {
    ret?: number;
    errcode?: number;
    upload_full_url?: string;
    upload_param?: { cdn_base?: string; [k: string]: unknown };
  };

  log.debug('getuploadurl OK: type=%s size=%d', mediaType, data.length);

  if (uploadUrlData.ret !== undefined && uploadUrlData.ret !== 0) {
    throw new Error(`WeChat getuploadurl failed: ret=${uploadUrlData.ret}, errcode=${uploadUrlData.errcode}`);
  }

  const uploadFullUrl = uploadUrlData.upload_full_url
    ?? `${uploadUrlData.upload_param?.cdn_base ?? ''}/upload`;

  if (!uploadFullUrl || !uploadFullUrl.startsWith('http')) {
    throw new Error('WeChat getuploadurl returned no upload URL');
  }

  // Step 2: encrypt and upload
  const encrypted = aesEcbEncrypt(data, key);

  const uploadRes = await fetch(uploadFullUrl, {
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
  };
}

export async function downloadMedia(
  downloadUrl: string,
  aesKeyEncoded: string,
  aesKeyType: 'media' | 'file',
  destPath: string,
): Promise<void> {
  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`WeChat download failed: HTTP ${res.status}`);
  }

  log.debug('download: %s → %s (%s)', downloadUrl.slice(0, 40), destPath, aesKeyType);

  const encrypted = Buffer.from(await res.arrayBuffer());

  const decodedKey = aesKeyType === 'media'
    ? decodeAesKeyForMedia(aesKeyEncoded)
    : decodeAesKeyForFile(aesKeyEncoded);

  const decrypted = aesEcbDecrypt(encrypted, decodedKey);

  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, decrypted);
}

export { fetchToTemp, safeUnlink } from '../../core/fs-utils.js';

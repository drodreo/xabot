import type { Client as FeishuSdkClient } from '@larksuiteoapi/node-sdk';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createLogger } from '../../core/logger.js';
const log = createLogger('FeishuUpload');

type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'stream';

function mimeToFileType(mimeType: string): FeishuFileType {
  const lower = mimeType.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('pdf')) return 'pdf';
  if (lower.includes('word') || lower.includes('doc')) return 'doc';
  if (lower.includes('excel') || lower.includes('sheet') || lower.includes('xls')) return 'xls';
  return 'stream';
}

/** Upload an image via Feishu SDK, returning image_key. */
export async function uploadImage(
  client: FeishuSdkClient,
  filePath: string,
): Promise<string> {
  const result = await client.im.image.create({
    data: {
      image_type: 'message',
      image: createReadStream(filePath),
    },
  });

  if (!result?.image_key) {
    throw new Error('Feishu image upload failed: no image_key returned');
  }

  log.debug('upload image: %s → %s', filePath, result.image_key);
  return result.image_key;
}

/** Upload a file via Feishu SDK. Returns the file_key and the actual file_name used. */
export async function uploadFile(
  client: FeishuSdkClient,
  filePath: string,
  mimeType: string,
  displayName?: string,
): Promise<{ key: string; name: string }> {
  const name = displayName || basename(filePath);
  const result = await client.im.file.create({
    data: {
      file_type: mimeToFileType(mimeType),
      file_name: name,
      file: createReadStream(filePath),
    },
  });

  if (!result?.file_key) {
    throw new Error('Feishu file upload failed: no file_key returned');
  }

  log.debug('upload file: %s → %s (name=%s)', filePath, result.file_key, name);
  return { key: result.file_key, name };
}

/** Download a resource file from a received message via im/v1/message-resource/get. */
export async function downloadMessageResource(
  client: FeishuSdkClient,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  destPath: string,
): Promise<void> {
  const result = await client.im.messageResource.get({
    params: { type },
    path: { message_id: messageId, file_key: fileKey },
  });

  await mkdir(dirname(destPath), { recursive: true });
  await result.writeFile(destPath);

  log.debug('download message resource: %s/%s (%s) → %s', messageId, fileKey, type, destPath);
}



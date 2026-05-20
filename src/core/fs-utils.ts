import { writeFile, unlink, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
const log = createLogger('fs-utils');

// --------------------------------------------------------------------------
// Download
// --------------------------------------------------------------------------

export async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --------------------------------------------------------------------------
// MIME type detection
// --------------------------------------------------------------------------

export async function detectMimeType(buf: Buffer, fileNameHint?: string): Promise<string> {
  const detected = await fileTypeFromBuffer(buf);
  return detected?.mime || inferMimeFromExt(fileNameHint ?? '');
}

// --------------------------------------------------------------------------
// Save temp file with metadata
// --------------------------------------------------------------------------

export async function saveTemp(buf: Buffer, urlPath: string, fileNameHint?: string): Promise<{ localUri: string; sha256: string; sizeBytes: number; mimeType: string }>;
export async function saveTemp(existingPath: string, fileNameHint?: string): Promise<{ localUri: string; sha256: string; sizeBytes: number; mimeType: string }>;
export async function saveTemp(
  first: Buffer | string,
  second?: string,
  third?: string,
): Promise<{ localUri: string; sha256: string; sizeBytes: number; mimeType: string }> {
  if (Buffer.isBuffer(first)) {
    const buf = first;
    const urlPath = second ?? '';
    const fileNameHint = third;
    const tmpPath = `${tmpdir()}/xabot_${randomUUID()}_${basename(new URL(urlPath).pathname || 'blob')}`;
    await writeFile(tmpPath, buf);
    const hash = createHash('sha256').update(buf).digest('hex');
    const mimeType = await detectMimeType(buf, fileNameHint);

    log.debug('saveTemp: %s → %s (%d bytes, sha256=%s)', urlPath.slice(0, 60), tmpPath, buf.length, hash.slice(0, 12));

    return { localUri: tmpPath, sha256: hash, sizeBytes: buf.length, mimeType };
  } else {
    const existingPath = first;
    const fileNameHint = second;
    const buf = await readFile(existingPath);
    const hash = createHash('sha256').update(buf).digest('hex');
    const mimeType = await detectMimeType(buf, fileNameHint);

    log.debug('saveTemp: existing %s (%d bytes, sha256=%s)', existingPath, buf.length, hash.slice(0, 12));

    return { localUri: existingPath, sha256: hash, sizeBytes: buf.length, mimeType };
  }
}

// --------------------------------------------------------------------------
// MIME fallback from extension
// --------------------------------------------------------------------------

const EXT_MIME_MAP: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'text/xml',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function inferMimeFromExt(name: string): string {
  if (!name) return '';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME_MAP[ext] ?? '';
}

// --------------------------------------------------------------------------
// Safe unlink
// --------------------------------------------------------------------------

/** Safe unlink — ignore ENOENT. */
export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('safeUnlink failed: %s — %s', path, err.message);
    }
  }
}

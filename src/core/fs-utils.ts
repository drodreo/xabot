import { writeFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
const log = createLogger('fs-utils');

export interface FetchResult {
  localUri: string;
  sha256: string;
  sizeBytes: number;
}

/** Download remote URL to a temp file, return temp path with hash and size. */
export async function fetchToTemp(remoteUrl: string): Promise<FetchResult> {
  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpPath = `${tmpdir()}/xabot_${randomUUID()}_${basename(new URL(remoteUrl).pathname || 'blob')}`;
  await writeFile(tmpPath, buf);
  const hash = createHash('sha256').update(buf).digest('hex');

  log.debug('fetchToTemp: %s → %s (%d bytes, sha256=%s)', remoteUrl.slice(0, 60), tmpPath, buf.length, hash.slice(0, 12));

  return { localUri: tmpPath, sha256: hash, sizeBytes: buf.length };
}

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

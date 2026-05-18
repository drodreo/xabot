import { writeFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Download remote URL to a temp file, return temp path. */
export async function fetchToTemp(remoteUrl: string): Promise<string> {
  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpPath = `${tmpdir()}/xabot_${randomUUID()}_${basename(new URL(remoteUrl).pathname || 'blob')}`;
  await writeFile(tmpPath, buf);
  return tmpPath;
}

/** Safe unlink — ignore ENOENT. */
export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

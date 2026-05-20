import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadToBuffer, detectMimeType, saveTemp, safeUnlink } from './fs-utils.js';
import { fileTypeFromBuffer } from 'file-type';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

// --------------------------------------------------------------------------
// downloadToBuffer
// --------------------------------------------------------------------------

describe('downloadToBuffer', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns buffer on HTTP 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('hello'),
    } as Response);

    const buf = await downloadToBuffer('https://example.com/file');
    expect(buf.toString()).toBe('hello');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    await expect(downloadToBuffer('https://example.com/missing')).rejects.toThrow('Fetch failed: HTTP 404');
  });
});

// --------------------------------------------------------------------------
// detectMimeType
// --------------------------------------------------------------------------

describe('detectMimeType', () => {
  beforeEach(() => {
    vi.mocked(fileTypeFromBuffer).mockReset();
  });

  it('returns detected mime when file-type finds a match', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' } as any);
    const result = await detectMimeType(Buffer.from('fake'));
    expect(result).toBe('image/png');
  });

  it('falls back to extension map when file-type returns undefined', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const result = await detectMimeType(Buffer.from('plain text'), 'report.txt');
    expect(result).toBe('text/plain');
  });

  it('falls back to empty string when no detection and no hint', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const result = await detectMimeType(Buffer.from('plain text'));
    expect(result).toBe('');
  });

  it('falls back to empty string for unknown extension', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const result = await detectMimeType(Buffer.from('data'), 'file.unknown');
    expect(result).toBe('');
  });
});

// --------------------------------------------------------------------------
// saveTemp
// --------------------------------------------------------------------------

describe('saveTemp', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xabot-test-'));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' } as any);
  });

  afterEach(async () => {
    await safeUnlink(tmpDir);
  });

  it('Buffer overload writes file and returns metadata', async () => {
    const buf = Buffer.from('image data');
    const result = await saveTemp(buf, 'https://example.com/photo.png');

    expect(result.localUri).toContain('photo.png');
    expect(result.sha256).toHaveLength(64);
    expect(result.sizeBytes).toBe(10);
    expect(result.mimeType).toBe('image/png');

    await safeUnlink(result.localUri);
  });

  it('Buffer overload passes fileNameHint to detectMimeType', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const buf = Buffer.from('plain text');
    const result = await saveTemp(buf, 'https://example.com/blob', 'notes.txt');
    expect(result.mimeType).toBe('text/plain');

    await safeUnlink(result.localUri);
  });

  it('Path overload reads existing file and returns metadata', async () => {
    const existingPath = join(tmpDir, 'existing.pdf');
    await writeFile(existingPath, Buffer.from('pdf content'));

    const result = await saveTemp(existingPath);

    expect(result.localUri).toBe(existingPath);
    expect(result.sha256).toHaveLength(64);
    expect(result.sizeBytes).toBe(11);
    expect(result.mimeType).toBe('image/png');
  });

  it('Path overload passes fileNameHint to detectMimeType', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const existingPath = join(tmpDir, 'data.csv');
    await writeFile(existingPath, Buffer.from('a,b\n1,2'));

    const result = await saveTemp(existingPath, 'data.csv');
    expect(result.mimeType).toBe('text/csv');
  });
});

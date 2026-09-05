import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import type { BookAssetRepository, ExportedBookCover } from '../../repositories/book-asset-repository';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { MAX_SOURCE_COVER_BYTES, persistSourceCover } from './source-cover';

const URL = 'https://covers.example/cover.png';
const novel = testNovel({ metadataRevision: 7 });

function repository(active?: ExportedBookCover) {
  const getActiveCover = vi.fn(async () => active);
  const save = vi.fn<NonNullable<BookAssetRepository['saveApprovedEnrichmentCover']>>();
  return {
    assets: { getActiveCover, saveApprovedEnrichmentCover: save } as unknown as BookAssetRepository,
    save,
  };
}

function stalledResponse(stage: 'headers' | 'body') {
  const cancel = vi.fn();
  const pull = vi.fn(() => new Promise<void>(() => undefined));
  const fetchMock = vi.fn((_url: string, _options: RequestInit) =>
    stage === 'headers'
      ? new Promise<Response>(() => undefined)
      : Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
            headers: { 'Content-Type': 'image/png' },
          }),
        ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, pull, cancel };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('source cover persistence', () => {
  it.each(['headers', 'body'] as const)('cancels a stalled %s request without saving a cover', async (stage) => {
    const { assets, save } = repository();
    const { fetchMock, pull, cancel } = stalledResponse(stage);
    const abort = new AbortController();
    const pending = persistSourceCover(assets, novel, URL, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(stage === 'headers' ? fetchMock : pull).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(fetchMock.mock.calls[0]![1].signal!.aborted).toBe(true);
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'] as const)('bounds a stalled %s request with its own deadline', async (stage) => {
    vi.useFakeTimers();
    const { assets, save } = repository();
    const { fetchMock, cancel } = stalledResponse(stage);
    const pending = persistSourceCover(assets, novel, URL, undefined, { timeoutMs: 20 });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(fetchMock.mock.calls[0]![1].signal!.aborted).toBe(true);
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the actual stream at 8 MiB even when Content-Length understates it', async () => {
    const { assets, save } = repository();
    const cancel = vi.fn();
    let supplied = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const length = supplied < MAX_SOURCE_COVER_BYTES ? 1024 * 1024 : 1;
        supplied += length;
        controller.enqueue(new Uint8Array(length));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
          }),
      ),
    );
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    await expect(persistSourceCover(assets, novel, URL)).rejects.toThrow('안전 한도');
    expect(cancel).toHaveBeenCalledOnce();
    expect(bitmap).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('preserves an existing approved cover without downloading a replacement', async () => {
    const { assets, save } = repository({
      blob: new Blob(),
      metadata: { provenance: 'approved_enrichment' },
    } as ExportedBookCover);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(persistSourceCover(assets, novel, URL)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves original cover bytes with a tagged integrity hash and metadata revision', async () => {
    const { assets, save } = repository({ metadata: { provenance: 'generated_preview' } } as ExportedBookCover);
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } })),
    );
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 120, height: 180, close })),
    );
    await expect(persistSourceCover(assets, novel, URL)).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      novel.id,
      expect.objectContaining({
        contentType: 'image/png',
        contentHash: integrityHash(bytes),
        pixelWidth: 120,
        pixelHeight: 180,
        expectedMetadataRevision: 7,
      }),
    );
    expect(new Uint8Array(await save.mock.calls[0]![1].blob.arrayBuffer())).toEqual(bytes);
  });

  it('closes a decoded bitmap and skips persistence if cancellation arrived during decoding', async () => {
    const { assets, save } = repository();
    const abort = new AbortController();
    const close = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('image bytes', { headers: { 'Content-Type': 'image/png' } })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        abort.abort();
        return { width: 120, height: 180, close };
      }),
    );
    await expect(persistSourceCover(assets, novel, URL, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
});

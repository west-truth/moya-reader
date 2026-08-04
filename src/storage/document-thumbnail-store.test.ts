import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReaderDbForTests } from './reader-database';
import { getDocumentThumbnail, pruneDocumentThumbnails, saveDocumentThumbnail } from './document-thumbnail-store';

function thumbnail(pageIndex: number, now: string) {
  return {
    bookId: 'book',
    pageIndex,
    pageHash: `page-${pageIndex}`,
    renderFingerprint: 'renderer-v1',
    contentType: 'image/jpeg' as const,
    pixelWidth: 112,
    pixelHeight: 142,
    blob: new Blob([new Uint8Array([pageIndex])], { type: 'image/jpeg' }),
    now,
  };
}

describe('document thumbnail cache', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('reuses only the matching page and renderer fingerprint', async () => {
    await saveDocumentThumbnail(thumbnail(0, '2026-08-01T00:00:00.000Z'));
    await expect(
      getDocumentThumbnail({
        bookId: 'book',
        pageIndex: 0,
        pageHash: 'page-0',
        renderFingerprint: 'renderer-v1',
        now: '2026-08-01T00:01:00.000Z',
      }),
    ).resolves.toMatchObject({ pageIndex: 0, lastAccessedAt: '2026-08-01T00:01:00.000Z' });
    await expect(
      getDocumentThumbnail({
        bookId: 'book',
        pageIndex: 0,
        pageHash: 'page-0',
        renderFingerprint: 'renderer-v2',
      }),
    ).resolves.toBeUndefined();
  });

  it('prunes the least recently accessed pages inside one book', async () => {
    await saveDocumentThumbnail(thumbnail(0, '2026-08-01T00:00:00.000Z'));
    await saveDocumentThumbnail(thumbnail(1, '2026-08-01T00:01:00.000Z'));
    await saveDocumentThumbnail(thumbnail(2, '2026-08-01T00:02:00.000Z'));
    await expect(pruneDocumentThumbnails('book', 2)).resolves.toBe(1);
    await expect(
      getDocumentThumbnail({
        bookId: 'book',
        pageIndex: 0,
        pageHash: 'page-0',
        renderFingerprint: 'renderer-v1',
      }),
    ).resolves.toBeUndefined();
  });

  it('also prunes by the configured byte budget', async () => {
    await saveDocumentThumbnail(thumbnail(0, '2026-08-01T00:00:00.000Z'));
    await saveDocumentThumbnail(thumbnail(1, '2026-08-01T00:01:00.000Z'));
    await saveDocumentThumbnail(thumbnail(2, '2026-08-01T00:02:00.000Z'));

    await expect(pruneDocumentThumbnails('book', 10, 2)).resolves.toBe(1);
    await expect(
      getDocumentThumbnail({
        bookId: 'book',
        pageIndex: 0,
        pageHash: 'page-0',
        renderFingerprint: 'renderer-v1',
      }),
    ).resolves.toBeUndefined();
  });
});

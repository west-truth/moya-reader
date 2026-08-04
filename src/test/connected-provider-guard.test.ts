import { describe, expect, it, vi } from 'vitest';
import { verifyConnectedProviderServerBookAttached } from '../sync/connected-provider-guard';

describe('connected provider attach guard', () => {
  it('passes when the server has the book and requested chapters', async () => {
    const client = {
      getBookManifest: vi.fn(async () => ({ book: { id: 'book_1', normalized_text_hash: 'book_hash' } })),
      listChapters: vi.fn(async () => ({
        chapters: [
          { id: 'chapter_1', text_hash: 'hash_1' },
          { id: 'chapter_2', textHash: 'hash_2' },
        ],
      })),
    };

    await expect(
      verifyConnectedProviderServerBookAttached(client, 'book_1', ['chapter_1', 'chapter_2'], {
        normalizedTextHash: 'book_hash',
        chapterTextHashById: {
          chapter_1: 'hash_1',
          chapter_2: 'hash_2',
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('reports a missing book before provider jobs are enqueued', async () => {
    const client = {
      getBookManifest: vi.fn(async () => {
        throw new Error('404');
      }),
      listChapters: vi.fn(async () => ({ chapters: [] })),
    };

    await expect(verifyConnectedProviderServerBookAttached(client, 'book_missing', ['chapter_1'])).resolves.toEqual({
      ok: false,
      reason: 'missing_book',
    });
    expect(client.listChapters).not.toHaveBeenCalled();
  });

  it('reports the first missing chapter for local connected TTS and labeling', async () => {
    const client = {
      getBookManifest: vi.fn(async () => ({ book: { id: 'book_1' } })),
      listChapters: vi.fn(async () => ({ chapters: [{ id: 'chapter_1' }] })),
    };

    await expect(
      verifyConnectedProviderServerBookAttached(client, 'book_1', ['chapter_1', 'chapter_2']),
    ).resolves.toEqual({ ok: false, reason: 'missing_chapter', chapterId: 'chapter_2' });
  });

  it('reports stale server book content before provider jobs are enqueued', async () => {
    const client = {
      getBookManifest: vi.fn(async () => ({ book: { id: 'book_1', normalized_text_hash: 'old_hash' } })),
      listChapters: vi.fn(async () => ({ chapters: [{ id: 'chapter_1', text_hash: 'hash_1' }] })),
    };

    await expect(
      verifyConnectedProviderServerBookAttached(client, 'book_1', ['chapter_1'], {
        normalizedTextHash: 'new_hash',
        chapterTextHashById: { chapter_1: 'hash_1' },
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_book' });
    expect(client.listChapters).not.toHaveBeenCalled();
  });

  it('reports stale requested chapter content for local connected TTS and labeling', async () => {
    const client = {
      getBookManifest: vi.fn(async () => ({ book: { id: 'book_1', normalizedTextHash: 'book_hash' } })),
      listChapters: vi.fn(async () => ({
        chapters: [
          { id: 'chapter_1', text_hash: 'hash_1' },
          { id: 'chapter_2', text_hash: 'old_hash_2' },
        ],
      })),
    };

    await expect(
      verifyConnectedProviderServerBookAttached(client, 'book_1', ['chapter_1', 'chapter_2'], {
        normalizedTextHash: 'book_hash',
        chapterTextHashById: {
          chapter_1: 'hash_1',
          chapter_2: 'new_hash_2',
        },
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_chapter', chapterId: 'chapter_2' });
  });
});

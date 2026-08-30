import { describe, expect, it, vi } from 'vitest';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteApiError } from '../services/remote/remote-api-contracts';
import { RemoteBookAssetRepository, RemoteSourceRangeResponseError } from './remote-book-asset-repository';
import { RemoteLibraryCatalogRepository } from './remote-library-catalog-repository';

describe('remote data safety repositories', () => {
  it('maps hosted source metadata and downloads the original blob', async () => {
    const blob = new Blob(['original source'], { type: 'text/plain' });
    const client = {
      getBookSourceMetadata: vi.fn(async () => ({
        source: {
          id: 'object_1',
          book_id: 'book_1',
          content_revision_id: 'revision_1',
          storage_key: 'user/object/book.txt',
          file_name: 'book.txt',
          content_type: 'text/plain',
          size_bytes: blob.size,
          raw_text_hash: 'sha256:source',
          source_encoding: 'utf-8',
          created_at: '2026-07-13T00:00:00.000Z',
        },
      })),
      getBookSource: vi.fn(async () => ({ blob, headers: new Headers(), status: 200 })),
      getBookSourceRange: vi.fn(async (_bookId: string, start: number, end: number) => ({
        blob: blob.slice(start, end),
        headers: new Headers({
          'content-range': `bytes ${start}-${end - 1}/${blob.size}`,
          'content-length': String(end - start),
        }),
        status: 206,
      })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);

    const exported = await repository.exportSource('book_1');

    expect(exported).toMatchObject({
      metadata: {
        id: 'object_1',
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        provenance: 'original',
        contentHash: 'sha256:source',
      },
      blob,
    });
    const randomAccess = await repository.openSource('book_1');
    expect(new TextDecoder().decode(await randomAccess?.readRange(9, 15))).toBe('source');
    expect(client.getBookSourceRange).toHaveBeenCalledWith('book_1', 9, 15, undefined);
  });

  it('rejects a source range response that was downgraded to a full HTTP 200 body', async () => {
    const blob = new Blob(['original source'], { type: 'application/pdf' });
    const client = {
      getBookSourceMetadata: vi.fn(async () => ({
        source: {
          id: 'object_1',
          book_id: 'book_1',
          file_name: 'book.pdf',
          content_type: 'application/pdf',
          size_bytes: blob.size,
        },
      })),
      getBookSourceRange: vi.fn(async () => ({ blob, headers: new Headers(), status: 200 })),
    } as unknown as RemoteApiClient;
    const source = await new RemoteBookAssetRepository(client).openSource('book_1');

    await expect(source.readRange(2, 5)).rejects.toBeInstanceOf(RemoteSourceRangeResponseError);
  });

  it('rejects truncated or misaddressed HTTP 206 source ranges', async () => {
    const blob = new Blob(['original source'], { type: 'application/pdf' });
    const client = {
      getBookSourceMetadata: vi.fn(async () => ({
        source: {
          id: 'object_1',
          book_id: 'book_1',
          file_name: 'book.pdf',
          content_type: 'application/pdf',
          size_bytes: blob.size,
        },
      })),
      getBookSourceRange: vi.fn(async () => ({
        blob: blob.slice(2, 4),
        headers: new Headers({
          'content-range': `bytes 1-2/${blob.size}`,
          'content-length': '2',
        }),
        status: 206,
      })),
    } as unknown as RemoteApiClient;
    const source = await new RemoteBookAssetRepository(client).openSource('book_1');

    await expect(source.readRange(2, 5)).rejects.toBeInstanceOf(RemoteSourceRangeResponseError);
  });

  it('uploads a user-reselected source through the hosted boundary', async () => {
    const blob = new Blob(['original source'], { type: 'text/plain' });
    const client = {
      reselectBookSource: vi.fn(async () => ({
        source: {
          id: 'object_1',
          book_id: 'book_1',
          content_revision_id: 'revision_1',
          file_name: 'book.txt',
          content_type: 'text/plain',
          size_bytes: blob.size,
          raw_text_hash: 'sha256:source',
          created_at: '2026-07-13T00:00:00.000Z',
        },
      })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);

    await expect(
      repository.reselectOriginalSource('book_1', {
        fileName: 'book.txt',
        contentType: 'text/plain',
        blob,
      }),
    ).resolves.toMatchObject({ id: 'object_1', bookId: 'book_1', provenance: 'original' });
    expect(client.reselectBookSource).toHaveBeenCalledWith('book_1', blob, {
      fileName: 'book.txt',
      contentType: 'text/plain',
    });
  });

  it('stores a generated hosted cover without presenting it as user supplied', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const client = {
      saveBookCover: vi.fn(async () => ({
        cover: {
          id: 'cover_generated',
          book_id: 'book_1',
          provenance: 'generated_preview',
          storage_key: 'user/book_1/covers/generated.jpg',
          file_name: 'generated.jpg',
          content_type: 'image/jpeg',
          byte_length: blob.size,
          content_hash: 'sha256:generated',
          pixel_width: 480,
          pixel_height: 720,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);

    await expect(
      repository.saveGeneratedCover?.('book_1', {
        blob,
        fileName: 'generated.jpg',
        contentType: 'image/jpeg',
        contentHash: 'sha256:generated',
        pixelWidth: 480,
        pixelHeight: 720,
        fit: 'contain',
        positionX: 50,
        positionY: 50,
        derivationFingerprint: 'source:page:renderer',
      }),
    ).resolves.toMatchObject({ id: 'cover_generated', provenance: 'generated_preview' });
    expect(client.saveBookCover).toHaveBeenCalledWith(
      'book_1',
      blob,
      expect.objectContaining({ provenance: 'generated_preview', derivationFingerprint: 'source:page:renderer' }),
    );
  });

  it('keeps approved enrichment provenance when hydrating a hosted cover', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const client = {
      getBookCoverMetadata: vi.fn(async () => ({
        cover: {
          id: 'cover_approved',
          book_id: 'book_1',
          provenance: 'approved_enrichment',
          storage_key: 'user/book_1/covers/approved.jpg',
          file_name: 'approved.jpg',
          content_type: 'image/jpeg',
          byte_length: blob.size,
          content_hash: 'sha256:approved',
          pixel_width: 480,
          pixel_height: 720,
          created_at: '2026-08-24T00:00:00.000Z',
        },
      })),
      getBookCover: vi.fn(async () => ({ blob, headers: new Headers() })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);

    await expect(repository.getActiveCover('book_1')).resolves.toMatchObject({
      metadata: { id: 'cover_approved', provenance: 'approved_enrichment' },
    });
  });

  it.each(['archive_embedded', 'epub_embedded'] as const)(
    'keeps %s provenance from inline hosted cover metadata without a second request',
    async (provenance) => {
      const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
      const getBookCoverMetadata = vi.fn();
      const client = {
        getBookCoverMetadata,
        getBookCover: vi.fn(async () => ({
          blob,
          headers: new Headers(),
          metadata: {
            id: `cover_${provenance}`,
            book_id: 'book_1',
            provenance,
            status: 'active',
            file_name: 'embedded.jpg',
            content_type: 'image/jpeg',
            byte_length: blob.size,
            content_hash: `sha256:${provenance}`,
            created_at: '2026-08-30T00:00:00.000Z',
          },
        })),
      } as unknown as RemoteApiClient;
      const repository = new RemoteBookAssetRepository(client);

      await expect(repository.getActiveCover('book_1')).resolves.toMatchObject({
        metadata: { provenance },
      });
      expect(getBookCoverMetadata).not.toHaveBeenCalled();
    },
  );

  it('retains and restores hosted approved enrichment covers through the safe repository port', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const current = {
      id: 'cover_approved',
      book_id: 'book_1',
      provenance: 'approved_enrichment',
      status: 'active',
      content_hash: 'sha256:approved',
      content_type: 'image/jpeg',
      byte_length: blob.size,
    };
    const previous = {
      id: 'cover_previous',
      book_id: 'book_1',
      provenance: 'user_supplied',
      status: 'superseded',
      content_hash: 'sha256:previous',
      content_type: 'image/jpeg',
      byte_length: 12,
    };
    const client = {
      saveApprovedEnrichmentBookCover: vi.fn(async () => ({
        cover: current,
        previousCover: previous,
        metadataRevision: 4,
      })),
      restoreApprovedEnrichmentBookCover: vi.fn(async () => ({
        cover: { ...previous, status: 'active' },
        metadataRevision: 5,
      })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);
    const saved = await repository.saveApprovedEnrichmentCover?.('book_1', {
      blob,
      fileName: 'approved.jpg',
      contentType: 'image/jpeg',
      contentHash: 'sha256:approved',
      pixelWidth: 480,
      pixelHeight: 720,
      fit: 'contain',
      positionX: 50,
      positionY: 50,
      expectedMetadataRevision: 3,
    });

    expect(saved).toMatchObject({
      current: { id: 'cover_approved', provenance: 'approved_enrichment', status: 'active' },
      previous: { id: 'cover_previous', status: 'superseded' },
      metadataRevision: 4,
    });
    expect(client.saveApprovedEnrichmentBookCover).toHaveBeenCalledWith(
      'book_1',
      blob,
      expect.objectContaining({ expectedMetadataRevision: 3 }),
    );

    await expect(
      repository.restoreApprovedEnrichmentCover?.('book_1', {
        expectedMetadataRevision: 4,
        expectedActiveAssetId: 'cover_approved',
        expectedActiveContentHash: 'sha256:approved',
        previousAssetId: 'cover_previous',
        previousContentHash: 'sha256:previous',
        previousFit: 'crop',
        previousPositionX: 50,
        previousPositionY: 50,
      }),
    ).resolves.toMatchObject({ current: { id: 'cover_previous', status: 'active' }, metadataRevision: 5 });
  });

  it('explains a hosted Web/server version mismatch before an approved cover can mutate data', async () => {
    const client = {
      saveApprovedEnrichmentBookCover: vi.fn(async () => {
        throw new RemoteApiError('Route not found', 404);
      }),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);

    await expect(
      repository.saveApprovedEnrichmentCover?.('book_1', {
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        fileName: 'approved.jpg',
        contentType: 'image/jpeg',
        contentHash: 'sha256:approved',
        pixelWidth: 480,
        pixelHeight: 720,
        fit: 'contain',
        positionX: 50,
        positionY: 50,
        expectedMetadataRevision: 3,
      }),
    ).rejects.toThrow('Moya Web과 서버를 함께 업데이트해 주세요.');
  });

  it('treats an authored-cover race as a skipped generated preview', async () => {
    const client = {
      saveBookCover: vi.fn(async () => {
        throw new RemoteApiError('generated cover cannot replace an authored cover', 409);
      }),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBookAssetRepository(client);

    await expect(
      repository.saveGeneratedCover?.('book_1', {
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        fileName: 'generated.jpg',
        contentType: 'image/jpeg',
        contentHash: 'sha256:generated',
        pixelWidth: 480,
        pixelHeight: 720,
        fit: 'contain',
        positionX: 50,
        positionY: 50,
        derivationFingerprint: 'source:page:renderer',
      }),
    ).resolves.toBeUndefined();
  });

  it('maps trash rows and sends revision-fenced restore and purge commands', async () => {
    const client = {
      listTrashBooks: vi.fn(async () => ({
        books: [
          {
            id: 'book_1',
            title: 'Trashed',
            source_file_name: 'book.txt',
            normalized_text_hash: 'hash',
            total_chapters: 1,
            total_characters: 10,
            total_paragraphs: 1,
            deleted_at: '2026-07-13T00:00:00.000Z',
            metadata_revision: 3,
          },
        ],
      })),
      restoreBook: vi.fn(async () => ({ ok: true as const, metadataRevision: 4 })),
      purgeBook: vi.fn(async () => ({ ok: true as const })),
      emptyTrash: vi.fn(async () => ({ ok: true as const, purged: 2 })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteLibraryCatalogRepository(client);

    expect(await repository.listTrash()).toEqual([
      expect.objectContaining({ id: 'book_1', deletedAt: '2026-07-13T00:00:00.000Z', metadataRevision: 3 }),
    ]);
    await repository.restore('book_1', 3);
    await repository.purge('book_1', 4);
    await expect(repository.emptyTrash()).resolves.toBe(2);
    expect(client.restoreBook).toHaveBeenCalledWith('book_1', 3);
    expect(client.purgeBook).toHaveBeenCalledWith('book_1', 4);
  });
});

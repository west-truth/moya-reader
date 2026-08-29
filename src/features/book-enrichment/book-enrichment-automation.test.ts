import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { BookEnrichmentCandidate } from './book-enrichment-contract';
import {
  applyEligibleMissingEnrichment,
  runBookEnrichmentBatch,
  selectMissingMetadataFields,
  type BookEnrichmentAutomationRunner,
} from './book-enrichment-automation';

function book(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '작품명',
    sourceFileName: '작품명.txt',
    rawText: '',
    normalizedText: '',
    rawTextHash: 'raw',
    normalizedTextHash: 'normalized',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 0,
    totalParagraphs: 0,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    metadataRevision: 0,
    ...overrides,
  };
}

const provenance = {
  extensionId: 'moya.webnovel-metadata' as const,
  extensionVersion: '1.0.0',
  contributionId: 'moya.webnovel-metadata.enrichment' as const,
  origin: 'bundled_trusted' as const,
  registrationFingerprint: 'registration',
  sourceFingerprints: ['source'],
  generatedAt: '2026-08-27T00:00:00.000Z',
  automation: {
    autoApplyEligible: true,
    matchType: 'exact_title',
    metadataQuality: 'full',
    reasons: [],
    authenticatedSearch: false,
  },
} as const;

function metadataCandidate(): Extract<BookEnrichmentCandidate, { kind: 'metadata' }> {
  return {
    schemaVersion: 1,
    id: 'metadata-1',
    bookId: 'book-1',
    kind: 'metadata',
    status: 'pending',
    baseMetadataRevision: 0,
    proposalGroupId: 'work-1',
    baseValues: { title: '작품명' },
    patch: {
      title: '정식 작품명',
      author: '작가',
      description: '소개',
      language: 'ko-KR',
      tags: ['판타지'],
    },
    provenance,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function coverCandidate(): Extract<BookEnrichmentCandidate, { kind: 'cover' }> {
  return {
    schemaVersion: 1,
    id: 'cover-1',
    bookId: 'book-1',
    kind: 'cover',
    status: 'pending',
    baseMetadataRevision: 0,
    proposalGroupId: 'work-1',
    baseCover: { present: false },
    cover: {
      blob: new Blob(['cover'], { type: 'image/jpeg' }),
      contentType: 'image/jpeg',
      contentHash: 'cover-hash',
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'crop',
      positionX: 50,
      positionY: 50,
      fileName: 'cover.jpg',
    },
    derivationFingerprint: 'cover',
    provenance,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

describe('book enrichment automation', () => {
  it('fills only missing values and treats an untouched filename title as replaceable', () => {
    expect(selectMissingMetadataFields(book(), metadataCandidate())).toEqual([
      'title',
      'author',
      'tags',
      'description',
      'language',
    ]);
    expect(
      selectMissingMetadataFields(
        book({ title: '내가 바꾼 제목', author: '내 작가', coverAssetId: 'cover', metadataRevision: 2 }),
        metadataCandidate(),
      ),
    ).toEqual(['tags', 'description', 'language']);
  });

  it('applies eligible metadata and cover but preserves an existing cover', async () => {
    const runner = {
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    } as unknown as BookEnrichmentAutomationRunner;
    await expect(
      applyEligibleMissingEnrichment(runner, book({ coverAssetId: 'existing-cover' }), [
        metadataCandidate(),
        coverCandidate(),
      ]),
    ).resolves.toEqual({ appliedCount: 1, errors: [] });
    expect(runner.applyMetadata).toHaveBeenCalledWith('metadata-1', [
      'title',
      'author',
      'tags',
      'description',
      'language',
    ]);
    expect(runner.applyCover).not.toHaveBeenCalled();
  });

  it('fills still-missing fields after another metadata edit while preserving existing values', async () => {
    const runner = {
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    } as unknown as BookEnrichmentAutomationRunner;
    await expect(
      applyEligibleMissingEnrichment(
        runner,
        book({ metadataRevision: 2, title: '내가 정한 제목', author: '기존 작가' }),
        [metadataCandidate(), coverCandidate()],
      ),
    ).resolves.toEqual({ appliedCount: 2, errors: [] });
    expect(runner.applyMetadata).toHaveBeenCalledWith('metadata-1', ['tags', 'description', 'language']);
    expect(runner.applyCover).toHaveBeenCalledWith('cover-1');
  });

  it('preserves a partial metadata apply when the cover step fails', async () => {
    const runner = {
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => {
        throw new Error('cover failed');
      }),
    } as unknown as BookEnrichmentAutomationRunner;
    await expect(
      applyEligibleMissingEnrichment(runner, book(), [metadataCandidate(), coverCandidate()]),
    ).resolves.toEqual({ appliedCount: 1, errors: ['cover failed'] });
  });

  it('does not mix metadata and cover from different proposal groups', async () => {
    const runner = {
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    } as unknown as BookEnrichmentAutomationRunner;
    await expect(
      applyEligibleMissingEnrichment(runner, book(), [
        metadataCandidate(),
        { ...coverCandidate(), proposalGroupId: 'another-work' },
      ]),
    ).resolves.toEqual({ appliedCount: 0, errors: [] });
    expect(runner.applyMetadata).not.toHaveBeenCalled();
    expect(runner.applyCover).not.toHaveBeenCalled();
  });

  it('stops before applying when cancellation arrives after lookup', async () => {
    const cancellation = new AbortController();
    const runner: BookEnrichmentAutomationRunner = {
      propose: vi.fn(async () => {
        cancellation.abort();
        return [metadataCandidate(), coverCandidate()];
      }),
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    };
    const result = await runBookEnrichmentBatch({
      runner,
      providerId: 'moya.webnovel-metadata.enrichment',
      books: [book()],
      automaticApply: 'missing_fields',
      signal: cancellation.signal,
    });
    expect(result).toMatchObject({ state: 'cancelled', completed: 0, applied: 0 });
    expect(runner.applyMetadata).not.toHaveBeenCalled();
    expect(runner.applyCover).not.toHaveBeenCalled();
  });

  it('continues a whole-library run after one lookup fails', async () => {
    const runner: BookEnrichmentAutomationRunner = {
      propose: vi
        .fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce([metadataCandidate(), coverCandidate()]),
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    };
    const result = await runBookEnrichmentBatch({
      runner,
      providerId: 'moya.webnovel-metadata.enrichment',
      books: [book(), book({ id: 'book-2', title: '둘째', sourceFileName: '둘째.txt' })],
      automaticApply: 'missing_fields',
    });
    expect(result).toMatchObject({ state: 'completed', total: 2, completed: 2, matched: 1, applied: 1, failed: 1 });
    expect(result.errors[0]?.message).toBe('network');
  });

  it('skips works that already have a cover and useful catalog metadata', async () => {
    const runner: BookEnrichmentAutomationRunner = {
      propose: vi.fn(async () => [metadataCandidate(), coverCandidate()]),
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    };
    const completeBook = book({
      id: 'complete',
      author: '작가',
      description: '소개',
      coverAssetId: 'cover',
    });
    const incompleteBook = book({ id: 'incomplete' });

    const result = await runBookEnrichmentBatch({
      runner,
      providerId: 'moya.webnovel-metadata.enrichment',
      books: [completeBook, incompleteBook],
      automaticApply: 'missing_fields',
    });

    expect(result).toMatchObject({ total: 1, completed: 1, skipped: 1, matched: 1, applied: 1 });
    expect(runner.propose).toHaveBeenCalledTimes(1);
    expect(runner.propose).toHaveBeenCalledWith('incomplete', 'moya.webnovel-metadata.enrichment', undefined);
  });

  it('never searches works that are still in the trash', async () => {
    const runner: BookEnrichmentAutomationRunner = {
      propose: vi.fn(async () => [metadataCandidate(), coverCandidate()]),
      applyMetadata: vi.fn(async () => undefined),
      applyCover: vi.fn(async () => undefined),
    };

    const result = await runBookEnrichmentBatch({
      runner,
      providerId: 'moya.webnovel-metadata.enrichment',
      books: [book({ deletedAt: '2026-08-29T00:00:00.000Z' }), book({ id: 'active' })],
      automaticApply: 'missing_fields',
    });

    expect(result).toMatchObject({ total: 1, completed: 1, skipped: 1, matched: 1, applied: 1 });
    expect(runner.propose).toHaveBeenCalledTimes(1);
    expect(runner.propose).toHaveBeenCalledWith('active', 'moya.webnovel-metadata.enrichment', undefined);
  });
});

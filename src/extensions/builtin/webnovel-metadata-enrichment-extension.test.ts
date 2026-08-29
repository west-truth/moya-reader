import { describe, expect, it, vi } from 'vitest';
import type { PublicBookMetadataSnapshot } from '../../features/book-enrichment/book-enrichment-contract';
import type { WebNovelMetadataCollectorResolveResult } from '../../services/webnovel-metadata-collector-client';
import { createWebNovelMetadataEnrichmentProposal } from './webnovel-metadata-enrichment-extension';

const book: PublicBookMetadataSnapshot = {
  bookId: 'book-42',
  metadataRevision: 3,
  title: '테스트 작품',
  author: '작가',
  tags: ['소장'],
  cover: { present: false },
};

const resolution: WebNovelMetadataCollectorResolveResult = {
  query: '테스트 작품',
  author: '작가',
  status: 'found',
  confidence: 1,
  matchType: 'exact_title_and_author',
  metadataQuality: 'full',
  metadata: {
    title: '테스트 작품 정식명',
    author: '작가',
    platform: 'ridi',
    platformWorkId: 'work-42',
    sourceUrl: 'https://ridibooks.com/books/123/42',
    coverUrl: 'https://img.ridicdn.net/cover.jpg',
    description: '플랫폼 작품 소개',
    genres: ['판타지'],
    tags: ['성장', '판타지'],
    status: 'completed',
    matchScore: 1,
    fetchedAt: '2026-08-27T10:00:00Z',
  },
  coverRef: 'cover_ref_12345678',
  searchedPlatforms: 5,
  failedPlatforms: [],
  platformErrors: {},
  skippedPlatforms: [],
  authenticatedSearch: true,
  autoApplyEligible: true,
  autoApplyReasons: [],
  fetchedAt: '2026-08-27T10:00:00Z',
};

describe('webnovel metadata enrichment extension mapping', () => {
  it('maps one resolved work into grouped metadata and cover drafts with provenance and automation evidence', async () => {
    const collector = {
      resolve: vi.fn(async () => resolution),
      downloadCover: vi.fn(async () => ({
        blob: new Blob([Uint8Array.from([0xff, 0xd8, 0xff]).buffer as ArrayBuffer], {
          type: 'image/jpeg',
        }),
        contentType: 'image/jpeg' as const,
        byteLength: 3,
      })),
    };

    const proposal = await createWebNovelMetadataEnrichmentProposal(collector, book);

    expect(collector.resolve).toHaveBeenCalledWith({ query: '테스트 작품', author: '작가' }, undefined);
    expect(collector.downloadCover).toHaveBeenCalledWith('cover_ref_12345678', undefined);
    expect(proposal.drafts).toHaveLength(2);
    const metadata = proposal.drafts.find((draft) => draft.kind === 'metadata');
    const cover = proposal.drafts.find((draft) => draft.kind === 'cover');
    expect(metadata).toMatchObject({
      kind: 'metadata',
      patch: {
        title: '테스트 작품 정식명',
        author: '작가',
        tags: ['소장', '판타지', '성장', '완결'],
        description: '플랫폼 작품 소개',
      },
      confidence: 1,
      providerId: 'webnovel-metadata-collector',
      sourceLabel: '리디',
      sourceUrl: 'https://ridibooks.com/books/123/42',
      automation: {
        autoApplyEligible: true,
        matchType: 'exact_title_and_author',
        metadataQuality: 'full',
        reasons: [],
        authenticatedSearch: true,
      },
    });
    expect(cover).toMatchObject({
      kind: 'cover',
      fileName: '테스트 작품 정식명.jpg',
      declaredContentType: 'image/jpeg',
      fit: 'contain',
      sourceLabel: '리디',
    });
    expect(cover?.proposalGroupId).toBe(metadata?.proposalGroupId);
    expect(cover?.licenseSummary).toContain('재배포·상업적 이용 권한은 확인되지 않았습니다');
    expect(cover?.sourceFingerprints).toEqual([
      expect.stringMatching(/^webnovel-work:sha256:/),
      expect.stringMatching(/^cover-content:sha256:/),
    ]);
  });

  it('keeps metadata usable and exposes a structured issue when a short-lived cover ref fails', async () => {
    const collector = {
      resolve: vi.fn(async () => resolution),
      downloadCover: vi.fn(async () => {
        throw Object.assign(new Error('추천 표지가 만료되었습니다.'), { code: 'cover_unavailable' });
      }),
    };

    const proposal = await createWebNovelMetadataEnrichmentProposal(collector, book);

    expect(proposal.drafts).toHaveLength(1);
    expect(proposal.drafts[0]?.kind).toBe('metadata');
    expect(proposal.drafts[0]?.rationale).toContain('추천 표지가 만료되었습니다.');
    expect(proposal.coverIssue).toEqual({
      code: 'cover_unavailable',
      message: '추천 표지가 만료되었습니다.',
    });
  });

  it('does not silently create a candidate from an ambiguous catalog match', async () => {
    const ambiguous: WebNovelMetadataCollectorResolveResult = {
      ...resolution,
      status: 'ambiguous',
      matchType: 'ambiguous',
      metadataQuality: undefined,
      metadata: undefined,
      coverRef: undefined,
      autoApplyEligible: false,
      autoApplyReasons: ['ambiguous_result'],
    };
    const collector = {
      resolve: vi.fn(async () => ambiguous),
      downloadCover: vi.fn(),
    };

    await expect(createWebNovelMetadataEnrichmentProposal(collector, book)).rejects.toThrow('작품 후보가 여러 개');
    expect(collector.downloadCover).not.toHaveBeenCalled();
  });

  it('looks up a distribution-style title by its canonical work title first', async () => {
    const collector = {
      resolve: vi.fn(async () => resolution),
      downloadCover: vi.fn(async () => ({
        blob: new Blob([Uint8Array.from([0xff]).buffer as ArrayBuffer], { type: 'image/jpeg' }),
        contentType: 'image/jpeg' as const,
        byteLength: 1,
      })),
    };

    await createWebNovelMetadataEnrichmentProposal(collector, {
      ...book,
      title: '바바리안 퀘스트 1-315 完',
      sourceFileName: '바바리안 퀘스트 1-315 完.txt',
    });

    expect(collector.resolve).toHaveBeenCalledTimes(1);
    expect(collector.resolve).toHaveBeenCalledWith({ query: '바바리안 퀘스트', author: '작가' }, undefined);
  });

  it('falls back to the preserved title only when the canonical lookup has no result', async () => {
    const notFound: WebNovelMetadataCollectorResolveResult = {
      ...resolution,
      query: '바바리안 퀘스트',
      status: 'not_found',
      metadata: undefined,
      coverRef: undefined,
      autoApplyEligible: false,
      autoApplyReasons: ['no_result'],
    };
    const collector = {
      resolve: vi.fn(async ({ query }: { query: string }) =>
        query === '바바리안 퀘스트' ? notFound : { ...resolution, query },
      ),
      downloadCover: vi.fn(async () => ({
        blob: new Blob([Uint8Array.from([0xff]).buffer as ArrayBuffer], { type: 'image/jpeg' }),
        contentType: 'image/jpeg' as const,
        byteLength: 1,
      })),
    };

    await createWebNovelMetadataEnrichmentProposal(collector, {
      ...book,
      title: '바바리안 퀘스트 1-315 完',
    });

    expect(collector.resolve.mock.calls.map(([input]) => input.query)).toEqual([
      '바바리안 퀘스트',
      '바바리안 퀘스트 1-315 完',
    ]);
  });
});

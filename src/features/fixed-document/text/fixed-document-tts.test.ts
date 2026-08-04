import { describe, expect, it } from 'vitest';
import {
  buildFixedDocumentTtsQueue,
  fixedDocumentTtsParagraph,
  fixedDocumentTtsRangeQuads,
  fixedDocumentTtsSegment,
  fixedDocumentTtsSourceRange,
  selectFixedDocumentTtsSources,
} from './fixed-document-tts';
import { buildFixedDocumentTtsWarmupRequests } from './fixed-document-tts-warmup';

const block = {
  id: 'block-warmup',
  revisionId: 'revision-warmup',
  bookId: 'book_1',
  pageIndex: 0,
  order: 0,
  role: 'paragraph' as const,
  text: '첫 문장입니다. 둘째 문장입니다.',
  normalizedText: '첫 문장입니다. 둘째 문장입니다.',
  quads: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.04 }],
  direction: 'ltr' as const,
};

describe('buildFixedDocumentTtsQueue', () => {
  it('skips low-confidence OCR sources but keeps native and acceptable OCR text', () => {
    const revision = {
      id: 'revision-ocr-low',
      bookId: 'book_1',
      pageIndex: 0,
      pageHash: 'page_hash_1',
      source: 'ocr' as const,
      engine: 'tesseract',
      engineVersion: '7',
      status: 'ready' as const,
      qualityScore: 0.44,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const selected = selectFixedDocumentTtsSources([
      { revision, blocks: [block] },
      {
        revision: { ...revision, id: 'revision-ocr-ready', pageIndex: 1, qualityScore: 0.45 },
        blocks: [{ ...block, id: 'block-ocr-ready', revisionId: 'revision-ocr-ready', pageIndex: 1 }],
      },
      {
        revision: { ...revision, id: 'revision-native', pageIndex: 2, source: 'pdf_native', qualityScore: 0.1 },
        blocks: [{ ...block, id: 'block-native', revisionId: 'revision-native', pageIndex: 2 }],
      },
    ]);

    expect(selected.sources.map((source) => source.revision.id)).toEqual(['revision-ocr-ready', 'revision-native']);
    expect(selected.skippedOcr).toEqual([{ revisionId: 'revision-ocr-low', pageIndex: 0, qualityScore: 0.44 }]);
  });

  it('keeps fixed block identity while applying spoken-text rules', () => {
    const queue = buildFixedDocumentTtsQueue({
      rate: 1.1,
      language: 'ko',
      rules: [
        {
          id: 'rule',
          scope: 'global',
          kind: 'replace_literal',
          pattern: 'API',
          replacement: '에이피아이',
          enabled: true,
          priority: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      blocks: [
        {
          id: 'block-1',
          revisionId: 'revision',
          bookId: 'book',
          pageIndex: 2,
          order: 0,
          role: 'paragraph',
          text: 'API 문서다.',
          normalizedText: 'api 문서다.',
          quads: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
          direction: 'ltr',
        },
      ],
    });

    expect(queue[0].block.id).toBe('block-1');
    expect(queue[0].playable).toMatchObject({ paragraphId: 'block-1', text: '에이피아이 문서다.', rate: 1.1 });
  });

  it('splits a PDF block into sentence items with exact source ranges', () => {
    const block = {
      id: 'block-sentences',
      revisionId: 'revision',
      bookId: 'book',
      pageIndex: 2,
      order: 0,
      role: 'paragraph' as const,
      text: '첫 문장입니다. 둘째 문장입니다.',
      normalizedText: '첫 문장입니다. 둘째 문장입니다.',
      quads: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.04 }],
      direction: 'ltr' as const,
    };
    const queue = buildFixedDocumentTtsQueue({ blocks: [block], language: 'ko', rate: 1 });

    expect(queue).toHaveLength(2);
    expect(queue.map((item) => item.playable.text)).toEqual(['첫 문장입니다.', '둘째 문장입니다.']);
    const secondRange = fixedDocumentTtsSourceRange(queue[1].playable, block);
    expect(block.text.slice(secondRange.startOffset, secondRange.endOffset).trim()).toBe('둘째 문장입니다.');
    expect(fixedDocumentTtsRangeQuads(block, secondRange.startOffset, secondRange.endOffset)[0].width).toBeLessThan(
      block.quads[0].width,
    );
  });

  it('materializes stable paragraph and segment anchors for provider cache playback', () => {
    const block = {
      id: 'block-1',
      revisionId: 'revision',
      bookId: 'book',
      pageIndex: 2,
      order: 3,
      role: 'paragraph' as const,
      text: 'PDF 본문입니다.',
      normalizedText: 'pdf 본문입니다.',
      quads: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      direction: 'ltr' as const,
    };
    const paragraph = fixedDocumentTtsParagraph(block, 'book', 'page-chapter');
    const segment = fixedDocumentTtsSegment(block, 'book', 'page-chapter');
    const sentenceSegment = fixedDocumentTtsSegment(block, 'book', 'page-chapter', {
      startOffset: 4,
      endOffset: 8,
    });

    expect(paragraph).toMatchObject({ id: 'block-1', chapterId: 'page-chapter', textHash: expect.any(String) });
    expect(segment).toMatchObject({
      id: 'block-1',
      paragraphId: 'block-1',
      startOffset: 0,
      endOffset: block.text.length,
      segmentTextHash: paragraph.textHash,
    });
    expect(sentenceSegment).toMatchObject({ startOffset: 4, endOffset: 8 });
    expect(sentenceSegment.segmentTextHash).not.toBe(paragraph.textHash);
  });
});

describe('buildFixedDocumentTtsWarmupRequests', () => {
  it('keeps the zero-based page to one-based chapter identity and exact sentence range', () => {
    const queue = buildFixedDocumentTtsQueue({
      blocks: [block],
      language: 'ko',
      rate: 1,
      voiceProfile: {
        id: 'voice_1',
        novelId: 'book_1',
        role: 'narrator',
        providerId: 'openai-tts',
        providerVoiceId: 'alloy',
        label: 'Narrator',
        speed: 1,
        isUserSelected: true,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const voiceProfile = {
      id: 'voice_1',
      novelId: 'book_1',
      role: 'narrator' as const,
      providerId: 'openai-tts',
      providerVoiceId: 'alloy',
      label: 'Narrator',
      speed: 1,
      isUserSelected: true,
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const requests = buildFixedDocumentTtsWarmupRequests({
      queue,
      chapters: [
        {
          id: 'chapter_page_1',
          novelId: 'book_1',
          index: 1,
          title: '1페이지',
          normalizedText: '1페이지',
          textHash: 'chapter_hash_1',
          rawStartOffset: 0,
          rawEndOffset: 1,
          characterCount: 4,
          paragraphCount: 1,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      voiceProfiles: [voiceProfile],
      contentRevision: 'revision_1',
    });

    expect(queue.map((item) => item.playable.sourceText)).toEqual(['첫 문장입니다.', '둘째 문장입니다.']);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      chapterId: 'chapter_page_1',
      paragraphId: block.id,
      request: {
        segmentIds: [block.id],
        renderSpec: {
          chapterId: 'chapter_page_1',
          segmentAnchors: [expect.objectContaining({ paragraphId: block.id })],
        },
      },
    });
    expect(requests[1].request.renderSpec?.segmentAnchors[0].startOffset).toBeGreaterThan(0);
  });
});

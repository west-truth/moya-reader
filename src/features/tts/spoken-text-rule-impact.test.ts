import { describe, expect, it } from 'vitest';
import type { Chapter, Paragraph, ParagraphPage, SpokenTextRule } from '../../domain/types';
import { inspectSpokenTextRuleImpact } from './spoken-text-rule-impact';

const chapter = (id: string, index: number, title: string): Chapter => ({
  id,
  novelId: 'book',
  index,
  title,
  normalizedText: '',
  textHash: `${id}-hash`,
  rawStartOffset: 0,
  rawEndOffset: 0,
  characterCount: 0,
  paragraphCount: 0,
  createdAt: '',
  updatedAt: '',
});

const paragraph = (chapterId: string, index: number, text: string, inlineSemantics?: Paragraph['inlineSemantics']) => ({
  id: `${chapterId}:${index}`,
  novelId: 'book',
  chapterId,
  index,
  text,
  startOffsetInChapter: 0,
  endOffsetInChapter: text.length,
  textHash: `${chapterId}:${index}:hash`,
  inlineSemantics,
});

const rule = (id: string, kind: SpokenTextRule['kind'], pattern: string): SpokenTextRule => ({
  id,
  scope: 'book',
  bookId: 'book',
  kind,
  pattern,
  enabled: true,
  priority: 0,
  updatedAt: '',
});

describe('inspectSpokenTextRuleImpact', () => {
  it('counts saved skip-rule impact in chapter order and returns bounded context', async () => {
    const chapters = [chapter('later', 1, '2화'), chapter('first', 0, '1화')];
    const pages = new Map<string, ParagraphPage[]>([
      [
        'first',
        [
          {
            id: 'first-page',
            novelId: 'book',
            chapterId: 'first',
            pageIndex: 0,
            startParagraphIndex: 0,
            endParagraphIndex: 1,
            paragraphs: [paragraph('first', 0, '[작가의 말] 다음 화에서 계속'), paragraph('first', 1, '본문')],
            textHash: 'first-page-hash',
          },
        ],
      ],
      [
        'later',
        [
          {
            id: 'later-page',
            novelId: 'book',
            chapterId: 'later',
            pageIndex: 0,
            startParagraphIndex: 0,
            endParagraphIndex: 0,
            paragraphs: [paragraph('later', 0, '공지: 휴재입니다')],
            textHash: 'later-page-hash',
          },
        ],
      ],
    ]);
    const controller = new AbortController();
    const result = await inspectSpokenTextRuleImpact({
      chapters,
      rules: [rule('author', 'skip_prefix', '[작가의 말]'), rule('notice', 'skip_prefix', '공지:')],
      signal: controller.signal,
      iterateParagraphPages: async function* (chapterId) {
        for (const page of pages.get(chapterId) ?? []) yield page;
      },
      sampleLimit: 1,
      sampleCharacterLimit: 24,
    });

    expect(result).toEqual({
      scannedParagraphCount: 3,
      affectedParagraphCount: 2,
      fullySkippedParagraphCount: 2,
      skippedRangeCount: 2,
      samples: [{ chapterTitle: '1화', paragraphIndex: 0, source: '[작가의 말] 다음 화에서 계속' }],
    });
  });

  it('does not report EPUB footnote-marker skips as user rule impact', async () => {
    const controller = new AbortController();
    const result = await inspectSpokenTextRuleImpact({
      chapters: [chapter('chapter', 0, '1화')],
      rules: [],
      signal: controller.signal,
      iterateParagraphPages: async function* () {
        yield {
          id: 'page',
          novelId: 'book',
          chapterId: 'chapter',
          pageIndex: 0,
          startParagraphIndex: 0,
          endParagraphIndex: 0,
          paragraphs: [paragraph('chapter', 0, '본문1', [{ start: 2, end: 3, kind: 'footnote_reference' }])],
          textHash: 'page-hash',
        };
      },
    });

    expect(result.affectedParagraphCount).toBe(0);
    expect(result.skippedRangeCount).toBe(0);
  });

  it('stops before scanning paragraph content when the request is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectSpokenTextRuleImpact({
        chapters: [chapter('chapter', 0, '1화')],
        rules: [rule('skip', 'skip_prefix', '공지')],
        signal: controller.signal,
        iterateParagraphPages: async function* () {
          yield {
            id: 'page',
            novelId: 'book',
            chapterId: 'chapter',
            pageIndex: 0,
            startParagraphIndex: 0,
            endParagraphIndex: 0,
            paragraphs: [paragraph('chapter', 0, '공지')],
            textHash: 'page-hash',
          };
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

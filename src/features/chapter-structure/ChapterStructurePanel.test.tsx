import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ChapterStructurePanel from './ChapterStructurePanel';
import type { ChapterStructureController } from './useChapterStructureController';

function controller(overrides: Partial<ChapterStructureController> = {}): ChapterStructureController {
  const chapters = [
    {
      id: 'chapter_1',
      index: 1,
      title: '1화 시작',
      rawStartOffset: 0,
      rawEndOffset: 100,
      paragraphCount: 2,
      characterCount: 90,
      sourcePreview: '1화 시작\n\n첫 문단',
      splitCandidates: [
        {
          paragraphId: 'paragraph_2',
          paragraphIndex: 2,
          label: '2화 새로운 시작',
          sourceOffset: 50,
          headingFamily: 'numbered_hwa_jang',
          headingNumber: 2,
          headingTitle: '2화 새로운 시작',
        },
      ],
    },
    {
      id: 'chapter_2',
      index: 2,
      title: '2화 다음',
      rawStartOffset: 100,
      rawEndOffset: 200,
      paragraphCount: 1,
      characterCount: 80,
      sourcePreview: '2화 다음\n\n둘째 문단',
      splitCandidates: [],
    },
  ];
  return {
    open: true,
    busy: false,
    available: true,
    editor: {
      bookId: 'book_1',
      baseContentRevisionId: 'revision_1',
      sourceProvenance: 'original',
      chapters,
      reviewItemCount: 0,
    },
    openPanel: vi.fn(async () => undefined),
    closePanel: vi.fn(),
    previewCommands: vi.fn(async () => undefined),
    clearPreview: vi.fn(),
    applyPreview: vi.fn(async () => undefined),
    rollbackLatest: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('ChapterStructurePanel', () => {
  it('renders visual boundary controls and keeps infrequent commands folded', () => {
    const markup = renderToStaticMarkup(<ChapterStructurePanel controller={controller()} />);
    expect(markup).toContain('화 구조 편집');
    expect(markup).toContain('경계 제거');
    expect(markup).toContain('새 화가 시작되는 줄을 선택하세요.');
    expect(markup).toContain('2화 새로운 시작');
    expect(markup).toContain('직접 수정');
    expect(markup).toContain('다시 나눈 결과 보기');
  });

  it('renders impact and apply controls for a prepared preview', () => {
    const base = controller();
    const markup = renderToStaticMarkup(
      <ChapterStructurePanel
        controller={controller({
          preview: {
            draftId: 'draft_1',
            bookId: 'book_1',
            baseContentRevisionId: 'revision_1',
            commands: [{ kind: 'rename', chapterId: 'chapter_1', title: '변경 제목' }],
            before: base.editor!.chapters,
            after: [{ ...base.editor!.chapters[0], title: '변경 제목' }, base.editor!.chapters[1]],
            affectedChapterIds: ['chapter_1'],
            impact: {
              preservedParagraphs: 3,
              addedParagraphs: 0,
              removedParagraphs: 0,
              readerAnnotationsAtRisk: 0,
              correctionsForReview: 0,
            },
            warnings: [],
            createdAt: '2026-07-13T00:00:00.000Z',
          },
        })}
      />,
    );
    expect(markup).toContain('변경 결과');
    expect(markup).toContain('변경 제목');
    expect(markup).toContain('변경 적용');
  });
});

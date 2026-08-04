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
      splitCandidates: [{ paragraphId: 'paragraph_2', paragraphIndex: 2, label: '두 번째 문단', sourceOffset: 50 }],
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
    previewCommand: vi.fn(async () => undefined),
    clearPreview: vi.fn(),
    applyPreview: vi.fn(async () => undefined),
    rollbackLatest: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('ChapterStructurePanel', () => {
  it('renders all supported chapter commands for the selected chapter', () => {
    const markup = renderToStaticMarkup(<ChapterStructurePanel controller={controller()} />);
    expect(markup).toContain('화 구조 편집');
    expect(markup).toContain('제목 변경 미리보기');
    expect(markup).toContain('경계 추가 미리보기');
    expect(markup).toContain('다음 화와 합치기 미리보기');
    expect(markup).toContain('이 지점부터 재분석');
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
    expect(markup).toContain('변경 미리보기');
    expect(markup).toContain('변경 제목');
    expect(markup).toContain('변경 적용');
  });
});

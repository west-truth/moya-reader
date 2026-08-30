import { describe, expect, it } from 'vitest';
import { parseNovelFile } from './parser';
import {
  applyChapterStructureCommands,
  chapterStructureViews,
  type ChapterStructureSnapshot,
} from './chapter-structure';

async function fixture(): Promise<ChapterStructureSnapshot> {
  const source =
    '1화 시작\n\n첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단입니다.\n\n2화 다음\n\n넷째 문단입니다.\n\n다섯째 문단입니다.';
  const bytes = new TextEncoder().encode(source);
  const parsed = await parseNovelFile('structure.txt', bytes.buffer, 'utf-8');
  return {
    bookId: parsed.novel.id,
    bookTitle: parsed.novel.title,
    baseContentRevisionId: 'revision_1',
    sourceText: parsed.novel.normalizedText,
    chapters: parsed.chapters,
    paragraphs: parsed.paragraphs,
  };
}

describe('chapter structure commands', () => {
  it('renames, splits at a paragraph boundary, and merges adjacent chapters without losing paragraphs', async () => {
    const snapshot = await fixture();
    const views = chapterStructureViews(snapshot);
    const split = views[0].splitCandidates[0];

    const renamedAndSplit = applyChapterStructureCommands(snapshot, [
      { kind: 'rename', chapterId: views[0].id, title: '새 제목' },
      { kind: 'split', chapterId: views[0].id, sourceOffset: split.sourceOffset, title: '나뉜 화' },
    ]);
    expect(renamedAndSplit.chapters.map((chapter) => chapter.title)).toEqual(['새 제목', '나뉜 화', '2화 다음']);
    expect(renamedAndSplit.paragraphs.map((paragraph) => paragraph.text)).toEqual(
      snapshot.paragraphs.map((paragraph) => paragraph.text),
    );
    expect(renamedAndSplit.chapters.map((chapter) => chapter.index)).toEqual([1, 2, 3]);

    const merged = applyChapterStructureCommands(
      { ...snapshot, chapters: renamedAndSplit.chapters, paragraphs: renamedAndSplit.paragraphs },
      [{ kind: 'merge_next', chapterId: views[0].id, titlePolicy: 'first' }],
    );
    expect(merged.chapters).toHaveLength(2);
    expect(merged.paragraphs.map((paragraph) => paragraph.text)).toEqual(
      snapshot.paragraphs.map((paragraph) => paragraph.text),
    );
  });

  it('reparses a chapter-aligned range with a different parser mode', async () => {
    const snapshot = await fixture();
    const result = applyChapterStructureCommands(snapshot, [
      { kind: 'reparse_range', startOffset: 0, splitMode: 'single' },
    ]);

    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]).toMatchObject({ rawStartOffset: 0, rawEndOffset: snapshot.sourceText.length });
    expect(result.paragraphs.map((paragraph) => paragraph.text).join('\n')).toContain('넷째 문단입니다.');
  });

  it('adds multiple boundaries to one original chapter from the last offset first', async () => {
    const snapshot = await fixture();
    const first = chapterStructureViews(snapshot)[0];
    expect(first.splitCandidates).toHaveLength(2);

    const result = applyChapterStructureCommands(snapshot, [
      {
        kind: 'split',
        chapterId: first.id,
        sourceOffset: first.splitCandidates[1].sourceOffset,
        title: '세 번째 구간',
      },
      {
        kind: 'split',
        chapterId: first.id,
        sourceOffset: first.splitCandidates[0].sourceOffset,
        title: '두 번째 구간',
      },
    ]);

    expect(result.chapters.map((chapter) => chapter.title)).toEqual([
      '1화 시작',
      '두 번째 구간',
      '세 번째 구간',
      '2화 다음',
    ]);
    expect(result.paragraphs.map((paragraph) => paragraph.text)).toEqual(
      snapshot.paragraphs.map((paragraph) => paragraph.text),
    );
  });

  it('rejects split offsets that are not paragraph boundaries', async () => {
    const snapshot = await fixture();
    expect(() =>
      applyChapterStructureCommands(snapshot, [
        { kind: 'split', chapterId: snapshot.chapters[0].id, sourceOffset: snapshot.chapters[0].rawStartOffset + 1 },
      ]),
    ).toThrow('paragraph');
  });
});

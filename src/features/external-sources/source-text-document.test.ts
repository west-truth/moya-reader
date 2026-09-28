import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceTextDocument } from './source-text-document';
import { defaultSettings } from '../../repositories/reader-defaults';
const input = {
  text: '첫 문단입니다.\n\n제2화\n\n마지막 문단입니다.',
  title: '1화',
  workId: 'work',
  episodeId: 'one',
  historyKey: 'user:one',
  settings: defaultSettings,
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('streamed text in the existing reader', () => {
  it('uses a single chapter, normal paragraph pages, scoped search and independent history', async () => {
    const onPosition = vi.fn(async () => undefined);
    const first = await sourceTextDocument({ ...input, onPosition });
    const page = await first.repository.getParagraphPage(first.chapter.id, 0);
    expect(page?.paragraphs.map((p) => p.text)).toEqual(['첫 문단입니다.', '제2화', '마지막 문단입니다.']);
    expect(await first.repository.getParagraphPage('another', 0)).toBeUndefined();
    expect(await first.repository.getParagraphPage(first.chapter.id, 1)).toBeUndefined();
    const paragraph = page!.paragraphs[2];
    await first.repository.saveReadingPosition({
      novelId: first.novel.id,
      chapterId: first.chapter.id,
      expectedContentRevisionId: first.novel.activeContentRevisionId,
      paragraphIndex: paragraph.index,
      paragraphId: paragraph.id,
      offsetInParagraph: 3,
      chapterProgress: 0.8,
      scrollTop: 250,
    });
    expect(onPosition).toHaveBeenCalledWith({ paragraphIndex: 3, offset: 3, textHash: paragraph.textHash, count: 3 });
    expect((await sourceTextDocument(input)).position?.paragraphIndex).toBe(3);
    expect((await sourceTextDocument({ ...input, fromStart: true })).position).toBeUndefined();
    expect((await sourceTextDocument({ ...input, text: '수정된 본문' })).position).toBeUndefined();
    expect((await sourceTextDocument({ ...input, historyKey: 'another-user:one' })).position).toBeUndefined();
    const second = await sourceTextDocument({ ...input, episodeId: 'two' });
    expect(second.novel.id).toBe(first.novel.id);
    expect(second.chapter.id).not.toBe(first.chapter.id);
    const result = await first.repository.searchParagraphPage({
      scope: 'chapter',
      chapterId: first.chapter.id,
      query: '문단',
      pageSize: 1,
      signal: new AbortController().signal,
    });
    expect(result.paragraphs[0].text).toBe('첫 문단입니다.');
    expect(result.nextCursor).toBe('1');
    await expect(
      first.repository.searchParagraphPage({
        scope: 'book',
        novelId: first.novel.id,
        query: '문단',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('현재 회차');
  });
  it('rejects empty content and aborted page reads', async () => {
    await expect(sourceTextDocument({ ...input, text: '' })).rejects.toThrow();
    const projected = await sourceTextDocument(input);
    await expect(
      projected.repository.getParagraphPage(projected.chapter.id, 0, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

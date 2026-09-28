import { hashSync } from '../../domain/hash';
import { saveSourceStreamPosition } from '../../external-sources/source-stream-history';
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
  it.each(['pending', 'failed'] as const)(
    'saves a reloadable paragraph and offset before a %s background save',
    async (mode) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const document = await sourceTextDocument({
        ...input,
        onPosition: () => (mode === 'pending' ? pending : Promise.reject(new Error('offline'))),
      });
      const saving = document.repository.saveReadingPosition({
        novelId: document.novel.id,
        chapterId: document.chapter.id,
        paragraphIndex: 3,
        offsetInParagraph: 4,
        chapterProgress: 0.8,
        scrollTop: 200,
      });
      const settled = saving.catch(() => undefined);
      const reloaded = await sourceTextDocument(input);
      expect(reloaded.position).toMatchObject({ paragraphIndex: 3, offsetInParagraph: 4 });
      release();
      await settled;
    },
  );
  it('continues saving newer local positions while the background queue is blocked', async () => {
    const document = await sourceTextDocument({ ...input, onPosition: () => new Promise(() => {}) });
    for (const paragraphIndex of [1, 2, 3]) {
      await document.repository.saveReadingPosition({
        novelId: document.novel.id,
        chapterId: document.chapter.id,
        paragraphIndex,
        offsetInParagraph: 2,
        chapterProgress: 0.5,
        scrollTop: 100,
      });
    }
    expect((await sourceTextDocument(input)).position).toMatchObject({ paragraphIndex: 3, offsetInParagraph: 2 });
  });
  it('keeps the position when a downloaded copy reconstructs the same paragraphs', async () => {
    const document = await sourceTextDocument({ ...input, text: '\n\n' + input.text + '\n\n' });
    await document.repository.saveReadingPosition({
      novelId: document.novel.id,
      chapterId: document.chapter.id,
      paragraphIndex: 3,
      offsetInParagraph: 2,
      chapterProgress: 0.5,
      scrollTop: 100,
    });
    const page = await document.repository.getParagraphPage(document.chapter.id, 0);
    const savedText = page!.paragraphs.map((p) => p.text).join('\n\n');
    expect((await sourceTextDocument({ ...input, text: savedText })).position).toMatchObject({
      paragraphIndex: 3,
      offsetInParagraph: 2,
    });
  });
  it('restores positions written with the previous raw text hash', async () => {
    const text = '\n\n' + input.text + '\n\n';
    saveSourceStreamPosition(`${input.historyKey}:text:${hashSync(text)}`, {
      page: 2,
      count: 3,
      fraction: 0,
      ratio: 1,
    });
    expect((await sourceTextDocument({ ...input, text })).position?.paragraphIndex).toBe(3);
  });
  it('rejects empty content and aborted page reads', async () => {
    await expect(sourceTextDocument({ ...input, text: '' })).rejects.toThrow();
    const projected = await sourceTextDocument(input);
    await expect(
      projected.repository.getParagraphPage(projected.chapter.id, 0, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

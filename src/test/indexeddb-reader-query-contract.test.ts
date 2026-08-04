import 'fake-indexeddb/auto';
import { IDBIndex as FakeIDBIndex } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { resetReaderDbForTests, saveImportedNovel } from '../storage/db';
import {
  createReaderQueryContractNovel,
  paragraphPagesFromParsed,
  readerQueryContract,
} from './reader-query-contract-suite';

readerQueryContract('IndexedDbReaderRepository reader query contract', async () => {
  await resetReaderDbForTests();
  const parsed = createReaderQueryContractNovel();
  await saveImportedNovel(parsed);
  return {
    source: new IndexedDbReaderRepository(),
    parsed,
    pages: paragraphPagesFromParsed(parsed),
  };
});

async function collectPages(
  source: AsyncIterable<ReturnType<typeof paragraphPagesFromParsed>[number]>,
): Promise<ReturnType<typeof paragraphPagesFromParsed>> {
  const pages: ReturnType<typeof paragraphPagesFromParsed> = [];
  for await (const page of source) pages.push(page);
  return pages;
}

describe('IndexedDbReaderRepository local bulk reads', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('pins one active revision for the lifetime of an iteration', async () => {
    const original = createReaderQueryContractNovel();
    await saveImportedNovel(original);
    const replacement = {
      novel: {
        ...original.novel,
        rawTextHash: 'replacement-raw-hash',
        normalizedTextHash: 'replacement-normalized-hash',
      },
      chapters: original.chapters.map((chapter) => ({ ...chapter, textHash: `${chapter.textHash}-replacement` })),
      paragraphs: original.paragraphs.map((paragraph) => ({
        ...paragraph,
        text: `replacement ${paragraph.text}`,
        textHash: `${paragraph.textHash}-replacement`,
      })),
    };
    const repository = new IndexedDbReaderRepository();
    const chapterId = original.chapters[0].id;
    const signal = new AbortController().signal;
    const iterator = repository.iterateParagraphPages({ chapterId, signal, batchSize: 1 })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.paragraphs[0].text).toBe(original.paragraphs[0].text);
    await saveImportedNovel(replacement);

    const pinnedPages = first.value ? [first.value] : [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      pinnedPages.push(next.value);
    }
    expect(pinnedPages.flatMap((page) => page.paragraphs).map((paragraph) => paragraph.text)).toEqual(
      original.paragraphs.filter((paragraph) => paragraph.chapterId === chapterId).map((paragraph) => paragraph.text),
    );

    const freshPages = await collectPages(repository.iterateParagraphPages({ chapterId, signal, batchSize: 1 }));
    expect(freshPages[0].paragraphs[0].text).toBe(replacement.paragraphs[0].text);
  });

  it('uses batchSize as the bounded IndexedDB read count and aborts before consuming a buffered page', async () => {
    const parsed = createReaderQueryContractNovel();
    await saveImportedNovel(parsed);
    const repository = new IndexedDbReaderRepository();
    const chapterId = parsed.chapters[0].id;
    const getAll = vi.spyOn(FakeIDBIndex.prototype, 'getAll');

    try {
      const pages = await collectPages(
        repository.iterateParagraphPages({ chapterId, signal: new AbortController().signal, batchSize: 2 }),
      );
      expect(pages).toHaveLength(2);
      expect(getAll.mock.calls.map((call) => call[1])).toEqual([2, 2]);

      getAll.mockClear();
      const controller = new AbortController();
      const iterable = repository.iterateParagraphPages({ chapterId, signal: controller.signal, batchSize: 2 });
      const iterator = iterable[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
      expect(getAll.mock.calls.map((call) => call[1])).toEqual([2]);
    } finally {
      getAll.mockRestore();
    }
  });
});

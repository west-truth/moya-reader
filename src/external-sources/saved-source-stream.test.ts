import { describe, expect, it, vi } from 'vitest';
import { savedFirstSourceStream } from './saved-source-stream';
import { testNovel, testChapter } from '../features/book-workspace/book-workspace-test-fixtures';
import type { ParagraphPage } from '../domain/types';

function fixture() {
  const remote = { open: vi.fn(async () => ({ pageCount: 1, loadPage: vi.fn(), close: vi.fn() })) };
  const blob = new Blob(['saved image'], { type: 'image/png' });
  const saved = {
    novel: testNovel({ format: 'image_archive' }),
    sectionId: 'episode-2',
    chapters: [
      testChapter(3, { id: 'third', documentSectionId: 'episode-2' }),
      testChapter(1, { id: 'other', documentSectionId: 'episode-1' }),
      testChapter(2, { id: 'second', documentSectionId: 'episode-2' }),
    ],
  };
  const getParagraphPage = vi.fn(async (id: string) => ({ paragraphs: [{ assetId: `image:${id}` }] }) as ParagraphPage);
  const getEmbeddedResource = vi.fn(async () => ({ blob, metadata: {} as never }));
  const port = savedFirstSourceStream(remote, {
    find: async (id) => (id === 'saved' ? saved : undefined),
    getParagraphPage,
    assets: { getEmbeddedResource },
  });
  return { port, remote, blob, saved, getParagraphPage, getEmbeddedResource, signal: new AbortController().signal };
}

describe('saved and streaming episodes in one viewer', () => {
  it('reads downloaded pages in section order without requesting the remote source', async () => {
    const f = fixture();
    const session = await f.port.open('saved', f.signal);
    expect(session.pageCount).toBe(2);
    expect(await session.loadPage(0, f.signal)).toBe(f.blob);
    expect(f.getParagraphPage).toHaveBeenCalledWith('second', 0, expect.any(AbortSignal));
    expect(f.remote.open).not.toHaveBeenCalled();
    session.close();
    await expect(session.loadPage(1, f.signal)).rejects.toThrow();
    expect(f.getParagraphPage).toHaveBeenCalledTimes(1);
  });
  it('streams an unsaved neighbor through the existing port', async () => {
    const f = fixture();
    await f.port.open('unsaved', f.signal);
    expect(f.remote.open).toHaveBeenCalledWith('unsaved', f.signal);
    expect(f.getEmbeddedResource).not.toHaveBeenCalled();
  });
  it('reports missing saved content without silently fetching a different remote revision', async () => {
    const f = fixture();
    f.getParagraphPage.mockResolvedValueOnce(undefined as never);
    const session = await f.port.open('saved', f.signal);
    await expect(session.loadPage(0, f.signal)).rejects.toThrow('저장된 페이지');
    expect(f.remote.open).not.toHaveBeenCalled();
    f.saved.chapters = [];
    await expect(f.port.open('saved', f.signal)).rejects.toThrow('저장된 회차');
  });
});

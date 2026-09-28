import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './useExternalSourceController';
import { useSourceStreamProgress } from './use-source-stream-progress';

function harness() {
  const links: ExternalSourceLink[] = [];
  const preferences = new Map<string, SourceReleasePreference>();
  const chapters = [1, 2].map((index) => ({
    id: `page-${index}`,
    novelId: 'book',
    index,
    documentSectionId: `episode-${index}`,
    paragraphCount: 1,
  })) as Chapter[];
  let novel = { id: 'book', activeContentRevisionId: 'r1' } as Novel;
  const saveImage = vi.fn(async (_page: number, chapter: Chapter) => {
    novel = { ...novel, lastReadChapterId: chapter.id };
  });
  const saveText = vi.fn(async () => undefined);
  const onRead = vi.fn();
  const onSaved = vi.fn();
  const notify = vi.fn();
  const options = {
    state: {
      listLinks: async () => links,
      listReleasePreferences: async () => [...preferences.values()],
      saveReleasePreferences: async (records: SourceReleasePreference[]) => {
        for (const record of records) preferences.set(record.id, record);
      },
    },
    getNovel: async () => novel,
    listChapters: async () => chapters,
    saveStreamPosition: saveImage,
    saveTextPosition: saveText,
    getParagraphPage: async () => ({ paragraphs: [{ id: 'p1', index: 1, textHash: 'hash' }] }),
    notify,
  } as unknown as UseExternalSourceControllerOptions;
  let progress!: ReturnType<typeof useSourceStreamProgress>;
  function Probe() {
    progress = useSourceStreamProgress({ current: () => options, onRead, onSaved });
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Probe />);
  });
  const item = (index: number, accountConnectionId = 'account') =>
    ({
      key: {
        connectorId: 'source',
        accountConnectionId,
        remoteId: `episode-${index}`,
      },
      collection: { remoteId: 'work' },
      release: { title: `${index}` },
    }) as ExternalSourceItemView;
  return {
    progress,
    item,
    preferences,
    saveImage,
    saveText,
    notify,
    onSaved,
    link: (index: number) => {
      links.push({ source: item(index).key, localBookId: 'book' } as ExternalSourceLink);
    },
    close: () => act(() => renderer.unmount()),
  };
}

describe('stream reading persistence', () => {
  it('discards uncommitted positions on reset and allows a new visit to the same episode', async () => {
    const h = harness();
    try {
      await h.progress.record(h.item(1), { kind: 'image', page: 4, count: 8 });
      await h.progress.clearWork({ ...h.item(1).key, remoteId: 'work' });
      h.preferences.clear();
      h.link(1);
      await h.progress.reconcile();
      expect(h.saveImage).not.toHaveBeenCalled();
      expect(h.preferences.size).toBe(0);
      await h.progress.record(h.item(1), { kind: 'image', page: 0, count: 1 });
      expect(h.saveImage).toHaveBeenCalledTimes(1);
      expect([...h.preferences.values()][0].read).toBe(true);
    } finally {
      h.close();
    }
  });

  it('records streamed episodes without downloads and replays only the latest location when downloads finish', async () => {
    const h = harness();
    try {
      await h.progress.record(h.item(1), { kind: 'image', page: 0, count: 1 });
      await h.progress.record(h.item(2), { kind: 'image', page: 0, count: 1 });
      expect([...h.preferences.values()].map((record) => [record.source.remoteId, record.read])).toEqual([
        ['episode-1', true],
        ['episode-2', true],
      ]);
      expect(h.saveImage).not.toHaveBeenCalled();
      h.link(1);
      await h.progress.reconcile();
      expect(h.saveImage).not.toHaveBeenCalled();
      h.link(2);
      await h.progress.reconcile();
      expect(h.saveImage).toHaveBeenCalledExactlyOnceWith(
        1,
        expect.objectContaining({ id: 'page-2' }),
        expect.anything(),
      );
      await h.progress.reconcile();
      expect(h.saveImage).toHaveBeenCalledTimes(1);
      expect(h.onSaved).toHaveBeenCalledWith(expect.objectContaining({ lastReadChapterId: 'page-2' }));
    } finally {
      h.close();
    }
  });

  it('retains a failed position for retry and keeps source accounts isolated', async () => {
    const h = harness();
    try {
      h.link(1);
      h.saveImage.mockRejectedValueOnce(new Error('offline'));
      await h.progress.record(h.item(1), { kind: 'image', page: 0, count: 1 });
      expect(h.notify).toHaveBeenCalled();
      await h.progress.record(h.item(2, 'other-account'), { kind: 'image', page: 0, count: 1 });
      await h.progress.reconcile();
      expect(h.saveImage).toHaveBeenCalledTimes(2);
      expect(h.preferences.size).toBe(2);
    } finally {
      h.close();
    }
  });

  it('keeps visited episodes read during rapid navigation without saving an older resume location', async () => {
    const h = harness();
    try {
      h.link(1);
      h.link(2);
      await Promise.all([
        h.progress.record(h.item(1), { kind: 'image', page: 0, count: 1 }),
        h.progress.record(h.item(2), { kind: 'image', page: 0, count: 1 }),
      ]);
      expect([...h.preferences.values()].every((record) => record.read)).toBe(true);
      expect(h.preferences.size).toBe(2);
      expect(h.saveImage).toHaveBeenCalledExactlyOnceWith(
        1,
        expect.objectContaining({ id: 'page-2' }),
        expect.anything(),
      );
    } finally {
      h.close();
    }
  });

  it('replays text anchors only when the downloaded text matches', async () => {
    const h = harness();
    try {
      await h.progress.record(h.item(1), {
        kind: 'text',
        paragraphIndex: 1,
        offset: 2,
        textHash: 'different',
        count: 1,
      });
      h.link(1);
      await h.progress.reconcile();
      expect(h.saveText).not.toHaveBeenCalled();
      await h.progress.record(h.item(1), { kind: 'text', paragraphIndex: 1, offset: 2, textHash: 'hash', count: 1 });
      expect(h.saveText).toHaveBeenCalledWith(expect.objectContaining({ chapterId: 'page-1', offsetInParagraph: 2 }));
    } finally {
      h.close();
    }
  });
});

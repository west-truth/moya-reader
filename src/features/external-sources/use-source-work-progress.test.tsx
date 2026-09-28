import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { releasePreferenceId, type SourceReleasePreference } from '../../external-sources/source-user-state';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import type { SourceWorkProgressProjection } from './source-work-progress';
import { useSourceWorkProgress } from './use-source-work-progress';

const connectorId = 'moya.external.test';
const subscription: ExternalSourceSubscriptionRecord = {
  id: 'subscription-1',
  connectorId,
  collectionRemoteId: 'work-1',
  navigationRef: 'work-1',
  title: '작품',
  knownReleaseIds: ['r1', 'r2', 'r3', 'r4'],
  newReleaseIds: [],
  availableReleaseCount: 4,
  lastCheckedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  schemaVersion: 1,
};
const links: ExternalSourceLink[] = ['r1', 'r2'].map((remoteId) => ({
  id: `link-${remoteId}`,
  source: { connectorId, remoteId },
  localBookId: 'book-1',
  collectionRemoteId: 'work-1',
  linkedAt: '2026-09-01T00:00:00.000Z',
}));
const streamedRead: SourceReleasePreference = {
  id: releasePreferenceId({ connectorId, remoteId: 'r3' }),
  kind: 'releasePreference',
  source: { connectorId, remoteId: 'r3' },
  read: true,
  updatedAt: '2026-09-02T00:00:00.000Z',
};
const finished = (id: string, section: string) =>
  ({ id, documentSectionId: section, documentSectionReadAt: '2026-09-02T00:00:00.000Z' }) as Chapter;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(listChapters: (id: string) => Promise<Chapter[]>, novels: Novel[]) {
  let result!: SourceWorkProgressProjection;
  function Probe({ books }: { books: Novel[] }) {
    result = useSourceWorkProgress({
      subscriptions: [subscription],
      links,
      preferences: [streamedRead],
      novels: books,
      listChapters,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe books={novels} />);
  });
  return {
    current: () => result,
    update: (books: Novel[]) => act(() => renderer.update(<Probe books={books} />)),
  };
}

describe('useSourceWorkProgress', () => {
  it('adds releases finished in the downloaded book and rescans only when that book changes', async () => {
    const listChapters = vi.fn(async () => [finished('c1', 'r1'), finished('c2', 'r1')]);
    const book = testNovel({ id: 'book-1', lastReadAt: '2026-09-02T00:00:00.000Z' });
    const probe = mount(listChapters, [book]);

    // Streamed reads count immediately; the downloaded book's history arrives after its scan.
    expect(probe.current().byNovelId.get('book-1')?.readCount).toBe(1);
    await flush();
    expect(probe.current().byNovelId.get('book-1')).toEqual({ readCount: 2, totalCount: 4, progress: 0.5 });

    probe.update([{ ...book }]);
    await flush();
    expect(listChapters).toHaveBeenCalledTimes(1);

    listChapters.mockResolvedValueOnce([finished('c1', 'r1'), finished('c3', 'r2')]);
    probe.update([{ ...book, lastReadAt: '2026-09-03T00:00:00.000Z' }]);
    await flush();
    expect(listChapters).toHaveBeenCalledTimes(2);
    expect(probe.current().byNovelId.get('book-1')?.readCount).toBe(3);
  });

  it('keeps release reads when a book cannot be scanned', async () => {
    const probe = mount(
      vi.fn(async () => {
        throw new Error('offline');
      }),
      [testNovel({ id: 'book-1' })],
    );
    await flush();

    expect(probe.current().byNovelId.get('book-1')?.readCount).toBe(1);
  });

  it('does not scan books that are not linked to a saved source work', async () => {
    const listChapters = vi.fn(async () => []);
    mount(listChapters, [testNovel({ id: 'book-1' }), testNovel({ id: 'plain-book' })]);
    await flush();

    expect(listChapters).toHaveBeenCalledTimes(1);
    expect(listChapters).toHaveBeenCalledWith('book-1');
  });
});

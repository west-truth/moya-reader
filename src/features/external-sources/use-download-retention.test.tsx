import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useDownloadRetention, type DownloadRetention } from './use-download-retention';
import type { UseExternalSourceControllerOptions } from './useExternalSourceController';
import { removeDownloadedReleases } from '../../external-sources/series/remove-downloaded-releases';
vi.mock('../../external-sources/series/remove-downloaded-releases', () => ({
  removeDownloadedReleases: vi.fn(async () => ({})),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function setup(enabled = false) {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ enabled, keep: 5 }), setItem: vi.fn() });
  let revision = 'r1';
  const options = {
    settingsScope: 'account-a',
    assets: {},
    importService: { supportsIncrementalImageSeriesAppend: true },
    getNovel: async () => ({
      id: 'book',
      title: 'Test',
      format: 'image_archive',
      activeContentRevisionId: revision,
      lastReadChapterId: 'c8',
    }),
    listNovels: async () => [await options.getNovel()],
    listChapters: async () =>
      Array.from({ length: 8 }, (_, n) => ({
        id: `c${n + 1}`,
        index: n,
        documentSectionId: `s${n + 1}`,
        documentSectionReadAt: '2026-09-20',
      })),
    state: {
      listLinks: async () =>
        Array.from({ length: 8 }, (_, n) => ({
          localBookId: 'book',
          collectionRemoteId: 'work',
          source: { connectorId: 'source', remoteId: `s${n + 1}` },
        })),
    },
    confirm: vi.fn(() => true),
    onLibraryChanged: vi.fn(async () => {}),
    notify: vi.fn(),
  };
  let current!: DownloadRetention;
  function Fixture({ reading = false, busy = false }) {
    current = useDownloadRetention({
      options: {
        ...options,
        readingTarget: reading ? { novelId: 'book', sectionId: 's8' } : undefined,
      } as unknown as UseExternalSourceControllerOptions,
      busy,
      setBusy: vi.fn(),
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Fixture reading />);
  });
  return {
    options,
    get current() {
      return current;
    },
    renderer,
    revise: () => {
      revision = 'r2';
    },
    render: async (reading: boolean, busy = false) => {
      await act(async () => renderer.update(<Fixture reading={reading} busy={busy} />));
    },
  };
}
it('defaults to no automatic deletion and requires confirmation for the previewed downloads', async () => {
  const test = await setup();
  await test.render(false);
  expect(removeDownloadedReleases).not.toHaveBeenCalled();
  await act(async () => test.current.inspect());
  expect(test.current.preview?.[0]?.sections).toEqual(['s1', 's2', 's3']);
  test.options.confirm.mockReturnValue(false);
  await act(async () => test.current.clean());
  expect(removeDownloadedReleases).not.toHaveBeenCalled();
  test.options.confirm.mockReturnValue(true);
  await act(async () => test.current.clean());
  expect(removeDownloadedReleases).toHaveBeenCalledWith(
    expect.objectContaining({ bookId: 'book', sectionIds: ['s1', 's2', 's3'], expectedContentRevisionId: 'r1' }),
  );
  expect(test.options.onLibraryChanged).toHaveBeenCalledOnce();
  act(() => test.renderer.unmount());
});
it('defers automatic deletion until leaving the reader and the queue is idle, then runs once', async () => {
  const test = await setup(true);
  expect(removeDownloadedReleases).not.toHaveBeenCalled();
  await test.render(false, true);
  expect(removeDownloadedReleases).not.toHaveBeenCalled();
  await test.render(false);
  expect(removeDownloadedReleases).toHaveBeenCalledOnce();
  await test.render(false);
  expect(removeDownloadedReleases).toHaveBeenCalledOnce();
  act(() => test.renderer.unmount());
});
it('does not apply a stale preview to changed book content', async () => {
  const test = await setup();
  await test.render(false);
  await act(async () => test.current.inspect());
  test.revise();
  await act(async () => test.current.clean());
  expect(removeDownloadedReleases).not.toHaveBeenCalled();
  act(() => test.renderer.unmount());
});

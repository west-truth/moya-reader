import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import { useLibraryManagementController, type LibraryManagementController } from './useLibraryManagementController';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '기존 제목',
    sourceFileName: '기존 제목.txt',
    normalizedTextHash: 'hash',
    totalChapters: 1,
    totalCharacters: 10,
    totalParagraphs: 1,
    coverSeed: 1,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    metadataRevision: 1,
    ...overrides,
  } as Novel;
}

async function harness(input: {
  current: Novel;
  assets?: BookAssetRepository;
  getNovel?: () => Promise<Novel | undefined>;
  patchMetadata?: LibraryCatalogRepository['patchMetadata'];
}) {
  let controller!: LibraryManagementController;
  let renderer!: ReactTestRenderer;
  const notify = vi.fn();
  const catalog = {
    listShelves: vi.fn(async () => []),
    listShelfMemberships: vi.fn(async () => []),
    patchMetadata:
      input.patchMetadata ??
      vi.fn(async (bookId: string, _patch: unknown, expectation?: { metadataRevision?: number }) => ({
        bookId,
        metadataRevision: (expectation?.metadataRevision ?? 0) + 1,
        changedAt: '2026-08-30T00:00:01.000Z',
      })),
  } as unknown as LibraryCatalogRepository;
  const assets = input.assets ?? ({} as BookAssetRepository);
  const getNovel = vi.fn(input.getNovel ?? (async () => input.current));
  function Harness() {
    controller = useLibraryManagementController({
      catalog,
      assets,
      getNovel,
      refreshNovels: vi.fn(async () => undefined),
      refreshAfterMutation: vi.fn(async () => undefined),
      notify,
      confirm: vi.fn(() => true),
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    get controller() {
      return controller;
    },
    renderer,
    catalog,
    getNovel,
    notify,
  };
}

describe('useLibraryManagementController metadata saves', () => {
  it('rebases unrelated server changes onto the latest metadata revision', async () => {
    const base = novel({ author: '작가', metadataRevision: 1 });
    const current = novel({ author: '작가', favorite: true, metadataRevision: 2 });
    const mounted = await harness({ current });

    act(() => mounted.controller.openMetadata(base));
    await act(async () => mounted.controller.saveBookDetails(base, { title: '새 제목' }, { kind: 'keep' }));

    expect(mounted.catalog.patchMetadata).toHaveBeenCalledWith('book-1', { title: '새 제목' }, {
      metadataRevision: 2,
      activeContentRevisionId: undefined,
    });
    expect(mounted.controller.panel).toBeUndefined();
    await act(async () => mounted.renderer.unmount());
  });

  it('preserves the editor and refuses to overwrite a field changed elsewhere', async () => {
    const base = novel({ author: '기존 작가', metadataRevision: 1 });
    const current = novel({ author: '자동 적용 작가', metadataRevision: 2 });
    const mounted = await harness({ current });

    act(() => mounted.controller.openMetadata(base));
    await act(async () => mounted.controller.saveBookDetails(base, { author: '직접 입력 작가' }, { kind: 'keep' }));

    expect(mounted.catalog.patchMetadata).not.toHaveBeenCalled();
    expect(mounted.controller.panel).toMatchObject({ kind: 'metadata', book: current });
    expect(mounted.notify).toHaveBeenCalledWith(expect.stringContaining('현재 입력은 보존'), 'danger');
    await act(async () => mounted.renderer.unmount());
  });

  it('admits only one mutation when the save action is tapped twice before a render', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const patchMetadata = vi.fn(async (bookId: string, _patch: unknown, expectation?: { metadataRevision?: number }) => {
      await pending;
      return {
        bookId,
        metadataRevision: (expectation?.metadataRevision ?? 0) + 1,
        changedAt: '2026-08-30T00:00:01.000Z',
      };
    });
    const base = novel();
    const mounted = await harness({ current: base, patchMetadata });

    act(() => mounted.controller.openMetadata(base));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = mounted.controller.saveBookDetails(base, { title: '새 제목' }, { kind: 'keep' });
      second = mounted.controller.saveBookDetails(base, { title: '새 제목' }, { kind: 'keep' });
    });
    release();
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(patchMetadata).toHaveBeenCalledOnce();
    await act(async () => mounted.renderer.unmount());
  });

  it('reuses its accepted revision when the same book is reopened before the catalog view catches up', async () => {
    let current = novel({ title: '첫 제목', metadataRevision: 1 });
    const staleCard = current;
    const patchMetadata = vi.fn(async (
      bookId: string,
      patch: { title?: string },
      expectation?: { metadataRevision?: number },
    ) => {
      const expectedRevision = expectation?.metadataRevision;
      current = novel({
        ...current,
        title: patch.title ?? current.title,
        metadataRevision: (expectedRevision ?? 0) + 1,
        updatedAt: `2026-08-30T00:00:0${expectedRevision ?? 0}.000Z`,
      });
      return {
        bookId,
        metadataRevision: current.metadataRevision ?? 0,
        changedAt: current.updatedAt,
      };
    });
    const mounted = await harness({ current, getNovel: async () => current, patchMetadata });

    act(() => mounted.controller.openMetadata(staleCard));
    await act(async () => mounted.controller.saveBookDetails(staleCard, { title: '두 번째 제목' }, { kind: 'keep' }));

    act(() => mounted.controller.openMetadata(staleCard));
    const reopened = mounted.controller.panel?.kind === 'metadata' ? mounted.controller.panel.book : undefined;
    expect(reopened).toMatchObject({ title: '두 번째 제목', metadataRevision: 2 });
    await act(async () => mounted.controller.saveBookDetails(reopened!, { title: '세 번째 제목' }, { kind: 'keep' }));

    expect(patchMetadata).toHaveBeenNthCalledWith(1, 'book-1', { title: '두 번째 제목' }, {
      metadataRevision: 1,
      activeContentRevisionId: undefined,
    });
    expect(patchMetadata).toHaveBeenNthCalledWith(2, 'book-1', { title: '세 번째 제목' }, {
      metadataRevision: 2,
      activeContentRevisionId: undefined,
    });
    expect(mounted.notify).not.toHaveBeenCalledWith(expect.stringContaining('현재 입력은 보존'), 'danger');
    await act(async () => mounted.renderer.unmount());
  });

  it('retries one metadata CAS race when only an unrelated field changed', async () => {
    const base = novel({ title: '기존 제목', author: '작가', metadataRevision: 1 });
    let current = base;
    const patchMetadata = vi
      .fn<LibraryCatalogRepository['patchMetadata']>()
      .mockImplementationOnce(async () => {
        current = novel({ ...current, favorite: true, metadataRevision: 2 });
        throw new Error('book metadata revision changed');
      })
      .mockImplementationOnce(async (bookId, patch, expectation) => {
        current = novel({
          ...current,
          title: patch.title ?? current.title,
          metadataRevision: (expectation?.metadataRevision ?? 0) + 1,
        });
        return {
          bookId,
          metadataRevision: current.metadataRevision ?? 0,
          changedAt: '2026-08-30T00:00:03.000Z',
        };
      });
    const mounted = await harness({ current, getNovel: async () => current, patchMetadata });

    act(() => mounted.controller.openMetadata(base));
    await act(async () => mounted.controller.saveBookDetails(base, { title: '새 제목' }, { kind: 'keep' }));

    expect(patchMetadata).toHaveBeenNthCalledWith(1, 'book-1', { title: '새 제목' }, {
      metadataRevision: 1,
      activeContentRevisionId: undefined,
    });
    expect(patchMetadata).toHaveBeenNthCalledWith(2, 'book-1', { title: '새 제목' }, {
      metadataRevision: 2,
      activeContentRevisionId: undefined,
    });
    expect(mounted.controller.panel).toBeUndefined();
    await act(async () => mounted.renderer.unmount());
  });

  it('does not retry a metadata CAS race when the same field changed elsewhere', async () => {
    const base = novel({ title: '기존 제목', metadataRevision: 1 });
    let current = base;
    const patchMetadata = vi.fn(async () => {
      current = novel({ ...current, title: '다른 기기의 제목', metadataRevision: 2 });
      throw new Error('book metadata revision changed');
    });
    const mounted = await harness({ current, getNovel: async () => current, patchMetadata });

    act(() => mounted.controller.openMetadata(base));
    await act(async () => mounted.controller.saveBookDetails(base, { title: '내 제목' }, { kind: 'keep' }));

    expect(patchMetadata).toHaveBeenCalledOnce();
    expect(mounted.controller.panel).toMatchObject({
      kind: 'metadata',
      book: { title: '다른 기기의 제목', metadataRevision: 2 },
    });
    expect(mounted.notify).toHaveBeenCalledWith(expect.stringContaining('현재 입력은 보존'), 'danger');
    await act(async () => mounted.renderer.unmount());
  });

  it('does not retry a cover replacement when another device changed the active cover layout', async () => {
    const base = novel({
      coverAssetId: 'cover-1',
      coverContentHash: 'sha256:cover-1',
      coverFit: 'crop',
      coverPositionX: 50,
      coverPositionY: 50,
      metadataRevision: 1,
    });
    let current = base;
    const saveCover = vi.fn(async () => {
      current = novel({ ...current, coverFit: 'contain', coverPositionX: 25, metadataRevision: 2 });
      throw new Error('book metadata revision changed');
    });
    const assets = { saveCover } as unknown as BookAssetRepository;
    const mounted = await harness({ current, assets, getNovel: async () => current });

    act(() => mounted.controller.openMetadata(base));
    await act(async () =>
      mounted.controller.saveBookDetails(
        base,
        {},
        {
          kind: 'replace',
          input: {
            blob: new Blob(['cover'], { type: 'image/jpeg' }),
            fileName: 'cover.jpg',
            contentType: 'image/jpeg',
            contentHash: 'sha256:replacement',
            pixelWidth: 600,
            pixelHeight: 900,
            fit: 'crop',
            positionX: 50,
            positionY: 50,
          },
        },
      ),
    );

    expect(saveCover).toHaveBeenCalledOnce();
    expect(mounted.controller.panel).toMatchObject({
      kind: 'metadata',
      book: { coverFit: 'contain', coverPositionX: 25, metadataRevision: 2 },
    });
    expect(mounted.notify).toHaveBeenCalledWith(expect.stringContaining('현재 입력은 보존'), 'danger');
    await act(async () => mounted.renderer.unmount());
  });

  it('does not retry a cover removal when another device changed the active cover position', async () => {
    const base = novel({
      coverAssetId: 'cover-1',
      coverContentHash: 'sha256:cover-1',
      coverFit: 'crop',
      coverPositionX: 50,
      coverPositionY: 50,
      metadataRevision: 1,
    });
    let current = base;
    const removeCover = vi.fn(async () => {
      current = novel({ ...current, coverPositionY: 75, metadataRevision: 2 });
      throw new Error('book metadata revision changed');
    });
    const assets = { removeCover } as unknown as BookAssetRepository;
    const mounted = await harness({ current, assets, getNovel: async () => current });

    act(() => mounted.controller.openMetadata(base));
    await act(async () => mounted.controller.saveBookDetails(base, {}, { kind: 'remove' }));

    expect(removeCover).toHaveBeenCalledOnce();
    expect(mounted.controller.panel).toMatchObject({
      kind: 'metadata',
      book: { coverPositionY: 75, metadataRevision: 2 },
    });
    expect(mounted.notify).toHaveBeenCalledWith(expect.stringContaining('현재 입력은 보존'), 'danger');
    await act(async () => mounted.renderer.unmount());
  });

  it('keeps an optimistic cover-removal marker when a stale card is reopened', async () => {
    const base = novel({
      coverAssetId: 'cover-1',
      coverContentHash: 'sha256:cover-1',
      metadataRevision: 1,
    });
    const removeCover = vi.fn(async () => undefined);
    const mounted = await harness({
      current: base,
      assets: { removeCover } as unknown as BookAssetRepository,
    });

    act(() => mounted.controller.openMetadata(base));
    await act(async () => mounted.controller.saveBookDetails(base, {}, { kind: 'remove' }));
    act(() => mounted.controller.openMetadata(base));

    expect(mounted.controller.panel).toMatchObject({
      kind: 'metadata',
      book: {
        coverAssetId: undefined,
        coverContentHash: undefined,
        coverRemovedAt: expect.any(String),
        metadataRevision: 2,
      },
    });
    await act(async () => mounted.renderer.unmount());
  });
});

import { expect, it, vi } from 'vitest';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import { executeLibraryBatch, externalSelectionId } from './library-batch';

it.each(['move_to_trash', 'restore_from_trash'] as const)(
  'routes mixed selections to both repositories for %s',
  async (kind) => {
    const book = testNovel({ id: 'local' });
    const applyBatch = vi.fn(async () => ({ results: [{ bookId: book.id, status: 'applied' }] }));
    const apply = vi.fn(async () => [{ bookId: 'stream', status: 'applied' as const }]);
    const result = await executeLibraryBatch(
      { kind },
      new Set(['local', externalSelectionId('stream')]),
      [book],
      { applyBatch } as unknown as LibraryCatalogRepository,
      { ids: ['stream'], apply },
    );
    expect(applyBatch).toHaveBeenCalledWith(
      { kind },
      [{ bookId: 'local', expectedRevision: book.metadataRevision ?? 0 }],
      expect.any(String),
    );
    expect(apply).toHaveBeenCalledWith(['stream'], kind === 'move_to_trash' ? 'trash' : 'restore');
    expect(result.results).toEqual([
      { bookId: 'local', status: 'applied' },
      { bookId: externalSelectionId('stream'), status: 'applied' },
    ]);
  },
);
it('handles stream-only selection without a local catalog', async () => {
  const apply = vi.fn(async () => [{ bookId: 'stream', status: 'applied' as const }]);
  const result = await executeLibraryBatch(
    { kind: 'move_to_trash' },
    new Set([externalSelectionId('stream')]),
    [],
    undefined,
    { ids: ['stream'], apply },
  );
  expect(result.results[0].status).toBe('applied');
});
it('reports partial failure and missing/importing targets without discarding successful results', async () => {
  const result = await executeLibraryBatch(
    { kind: 'move_to_trash' },
    new Set(['local', 'importing', externalSelectionId('stream')]),
    [testNovel({ id: 'local' })],
    {
      applyBatch: async () => {
        throw new Error('local unavailable');
      },
    } as unknown as LibraryCatalogRepository,
    { ids: ['stream'], apply: async () => [{ bookId: 'stream', status: 'applied' }] },
  );
  expect(result.results.filter((item) => item.status === 'failed').map((item) => item.bookId)).toEqual([
    'local',
    'importing',
  ]);
  expect(result.results.find((item) => item.bookId === externalSelectionId('stream'))?.status).toBe('applied');
});
it('rejects unsupported mixed metadata operations before changing any local book', async () => {
  const applyBatch = vi.fn();
  const apply = vi.fn();
  await expect(
    executeLibraryBatch(
      { kind: 'set_favorite', favorite: true },
      new Set(['local', externalSelectionId('stream')]),
      [testNovel({ id: 'local' })],
      { applyBatch } as unknown as LibraryCatalogRepository,
      { ids: ['stream'], apply },
    ),
  ).rejects.toThrow('스트리밍');
  expect(applyBatch).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it.each(['add_to_shelf', 'remove_from_shelf'] as const)(
  'applies %s to streaming, local and partly downloaded works',
  async (kind) => {
    const local = testNovel({ id: 'local' });
    const downloaded = testNovel({ id: 'downloaded' });
    const catalog = {
      listShelves: async () => [{ id: 'shelf' }],
      applyBatch: vi.fn(async () => ({
        results: [local, downloaded].map((book) => ({ bookId: book.id, status: 'applied' })),
      })),
    } as unknown as LibraryCatalogRepository;
    const setShelfMembership = vi.fn(async () => {});
    const apply = vi.fn();
    const receipt = await executeLibraryBatch(
      { kind, shelfId: 'shelf' },
      new Set(['local', 'downloaded', externalSelectionId('stream')]),
      [local, downloaded],
      catalog,
      {
        ids: ['stream', 'linked'],
        linkedBooks: [{ id: 'linked', bookId: 'downloaded' }],
        setShelfMembership,
        apply,
      },
    );
    expect(setShelfMembership.mock.calls).toEqual([
      ['stream', 'shelf', kind === 'add_to_shelf'],
      ['linked', 'shelf', kind === 'add_to_shelf'],
    ]);
    expect(receipt.results).toHaveLength(3);
    expect(receipt.results.every((result) => result.status === 'applied')).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  },
);
it('retains failed shelf targets for retry without undoing successful local or streamed changes', async () => {
  const receipt = await executeLibraryBatch(
    { kind: 'remove_from_shelf', shelfId: 'shelf' },
    new Set(['downloaded', 'external:good', 'external:bad']),
    [testNovel({ id: 'downloaded' })],
    {
      listShelves: async () => [{ id: 'shelf' }],
      applyBatch: async () => ({ results: [{ bookId: 'downloaded', status: 'applied' }] }),
    } as unknown as LibraryCatalogRepository,
    {
      ids: ['good', 'bad'],
      linkedBooks: [{ id: 'linked', bookId: 'downloaded' }],
      apply: vi.fn(),
      setShelfMembership: async (id) => {
        if (id !== 'good') throw new Error('save failed');
      },
    },
  );
  expect(receipt.results.filter((result) => result.status === 'failed').map((result) => result.bookId)).toEqual([
    'downloaded',
    'external:bad',
  ]);
  expect(receipt.results.find((result) => result.bookId === 'external:good')?.status).toBe('applied');
});
it('rejects a removed destination shelf before mutating either backend', async () => {
  const applyBatch = vi.fn();
  const setShelfMembership = vi.fn();
  await expect(
    executeLibraryBatch(
      { kind: 'add_to_shelf', shelfId: 'removed' },
      new Set(['local', 'external:stream']),
      [testNovel({ id: 'local' })],
      {
        listShelves: async () => [],
        applyBatch,
      } as unknown as LibraryCatalogRepository,
      { ids: ['stream'], apply: vi.fn(), setShelfMembership },
    ),
  ).rejects.toThrow('책장을 찾을 수 없습니다');
  expect(applyBatch).not.toHaveBeenCalled();
  expect(setShelfMembership).not.toHaveBeenCalled();
});

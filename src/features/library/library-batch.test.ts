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

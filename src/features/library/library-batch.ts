import type { Novel } from '../../domain/types';
import type {
  BatchLibraryCommand,
  BatchLibraryItemResult,
  BatchLibraryReceipt,
  LibraryCatalogRepository,
} from '../../repositories/library-catalog-repository';

export const externalSelectionId = (id: string) => `external:${id}`;
export interface ExternalLibraryBatch {
  readonly ids: readonly string[];
  apply(ids: readonly string[], action: 'trash' | 'restore'): Promise<readonly BatchLibraryItemResult[]>;
}

/** Keep a result for every selection, including failures in either storage backend. */
export async function executeLibraryBatch(
  command: BatchLibraryCommand,
  selectedIds: ReadonlySet<string>,
  books: readonly Novel[],
  catalog?: LibraryCatalogRepository,
  external?: ExternalLibraryBatch,
): Promise<BatchLibraryReceipt> {
  const id = globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}`;
  const remoteIds = external?.ids.filter((key) => selectedIds.has(externalSelectionId(key))) ?? [];
  if (remoteIds.length && command.kind !== 'move_to_trash' && command.kind !== 'restore_from_trash')
    throw new Error('스트리밍 작품이 포함된 선택에서는 휴지통 이동과 복원을 사용할 수 있습니다.');
  const local = books.filter((book) => selectedIds.has(book.id));
  const results: BatchLibraryItemResult[] = [];
  const failure = (bookId: string, error: unknown): BatchLibraryItemResult => ({
    bookId,
    status: 'failed',
    reason: error instanceof Error ? error.message : '작품을 변경하지 못했습니다.',
  });
  if (local.length) {
    try {
      if (!catalog) throw new Error('작품 저장소를 사용할 수 없습니다.');
      results.push(
        ...(
          await catalog.applyBatch(
            command,
            local.map((book) => ({ bookId: book.id, expectedRevision: book.metadataRevision ?? 0 })),
            id,
          )
        ).results,
      );
    } catch (error) {
      results.push(...local.map((book) => failure(book.id, error)));
    }
  }
  if (remoteIds.length && external) {
    try {
      results.push(
        ...(await external.apply(remoteIds, command.kind === 'move_to_trash' ? 'trash' : 'restore')).map((result) => ({
          ...result,
          bookId: externalSelectionId(result.bookId),
        })),
      );
    } catch (error) {
      results.push(...remoteIds.map((key) => failure(externalSelectionId(key), error)));
    }
  }
  for (const key of selectedIds) {
    if (!results.some((result) => result.bookId === key))
      results.push(failure(key, new Error('가져오는 중이거나 더 이상 찾을 수 없는 작품입니다.')));
  }
  return { id, idempotencyKey: id, command, results, createdAt: new Date().toISOString() };
}

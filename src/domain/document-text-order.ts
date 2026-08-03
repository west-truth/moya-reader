import { persistentId128 } from '@noveldesk/text-core/hash';
import type { DocumentTextBlock, DocumentTextOrderOverride, DocumentTextRevision } from './types';

function rounded(value: number): string {
  return Math.round(value * 1000).toString();
}

export function documentTextBlockFingerprint(block: DocumentTextBlock): string {
  return persistentId128('document_text_block_source', [
    block.normalizedText,
    block.role,
    block.direction,
    ...block.quads.flatMap((quad) => [rounded(quad.x), rounded(quad.y), rounded(quad.width), rounded(quad.height)]),
  ]);
}

export function applyDocumentTextOrderOverride(
  blocks: readonly DocumentTextBlock[],
  override?: DocumentTextOrderOverride,
  options: { readonly includeExcluded?: boolean } = {},
): DocumentTextBlock[] {
  if (!override) return blocks.map((block, order) => ({ ...block, order }));
  const rank = new Map(override.orderedBlockFingerprints.map((fingerprint, index) => [fingerprint, index]));
  const excluded = new Set(override.excludedBlockFingerprints);
  return [...blocks]
    .filter((block) => options.includeExcluded || !excluded.has(documentTextBlockFingerprint(block)))
    .sort((left, right) => {
      const leftRank = rank.get(documentTextBlockFingerprint(left));
      const rightRank = rank.get(documentTextBlockFingerprint(right));
      return (leftRank ?? rank.size + left.order) - (rightRank ?? rank.size + right.order);
    })
    .map((block, order) => ({ ...block, order }));
}

export function createDocumentTextOrderOverride(input: {
  readonly revision: DocumentTextRevision;
  readonly orderedBlocks: readonly DocumentTextBlock[];
  readonly excludedBlockIds: ReadonlySet<string>;
  readonly existing?: DocumentTextOrderOverride;
  readonly now?: string;
}): DocumentTextOrderOverride {
  const timestamp = input.now ?? new Date().toISOString();
  return {
    id: persistentId128('document_text_order_override', [input.revision.bookId, String(input.revision.pageIndex)]),
    bookId: input.revision.bookId,
    pageIndex: input.revision.pageIndex,
    pageHash: input.revision.pageHash,
    sourceRevisionId: input.revision.id,
    orderedBlockFingerprints: input.orderedBlocks.map(documentTextBlockFingerprint),
    excludedBlockFingerprints: input.orderedBlocks
      .filter((block) => input.excludedBlockIds.has(block.id))
      .map(documentTextBlockFingerprint),
    createdAt: input.existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

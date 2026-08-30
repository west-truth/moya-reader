import type { BookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import type { Novel } from '../../domain/types';

export function normalizeMetadataTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export interface MetadataEditorDraft {
  readonly title: string;
  readonly author: string;
  readonly seriesTitle: string;
  readonly seriesIndex: string;
  readonly tags: readonly string[];
  readonly description: string;
  readonly language: string;
  readonly fit: 'crop' | 'contain';
  readonly positionX: number;
  readonly positionY: number;
}

export function buildMetadataPatch(
  book: Novel,
  draft: MetadataEditorDraft,
  coverAction: 'keep' | 'remove' | 'replace',
): BookMetadataPatch {
  const patch: Record<string, unknown> = {};
  const title = draft.title.trim();
  const author = draft.author.trim() || null;
  const seriesTitle = draft.seriesTitle.trim() || null;
  const seriesIndex = draft.seriesIndex.trim() ? Number(draft.seriesIndex) : null;
  const tags = normalizeMetadataTags(draft.tags);
  const description = draft.description.trim() || null;
  const language = draft.language.trim() || null;
  if (title !== book.title) patch.title = title;
  if (author !== (book.author ?? null)) patch.author = author;
  if (seriesTitle !== (book.seriesTitle ?? null)) patch.seriesTitle = seriesTitle;
  if (seriesIndex !== (book.seriesIndex ?? null)) patch.seriesIndex = seriesIndex;
  if (JSON.stringify(tags) !== JSON.stringify(normalizeMetadataTags(book.tags ?? []))) patch.tags = tags;
  if (description !== (book.description ?? null)) patch.description = description;
  if (language !== (book.language ?? null)) patch.language = language;
  if (coverAction === 'keep') {
    if (draft.fit !== (book.coverFit ?? 'crop')) patch.coverFit = draft.fit;
    if (draft.positionX !== (book.coverPositionX ?? 50)) patch.coverPositionX = draft.positionX;
    if (draft.positionY !== (book.coverPositionY ?? 50)) patch.coverPositionY = draft.positionY;
  }
  return patch as BookMetadataPatch;
}

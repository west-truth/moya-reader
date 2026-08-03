import { persistentId128 } from '../id-hash-contract';

export function bookmarkId(input: {
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  progress: number;
  createdAt: string;
}): string {
  return persistentId128('bookmark', [
    input.novelId,
    input.chapterId,
    input.paragraphId ?? '',
    String(input.progress),
    input.createdAt,
  ]);
}

export function readerHighlightId(input: {
  novelId: string;
  chapterId: string;
  paragraphId: string;
  quote: string;
  createdAt: string;
}): string {
  return persistentId128('highlight', [
    input.novelId,
    input.chapterId,
    input.paragraphId,
    input.quote,
    input.createdAt,
  ]);
}

export function readerNoteId(input: {
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  body: string;
  createdAt: string;
}): string {
  return persistentId128('note', [
    input.novelId,
    input.chapterId,
    input.paragraphId ?? '',
    input.body,
    input.createdAt,
  ]);
}

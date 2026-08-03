import { persistentId128 } from '../id-hash-contract';

export function parsedNovelId(fileName: string, normalizedTextHash: string): string {
  return persistentId128('novel', [fileName, normalizedTextHash]);
}

export function parsedChapterId(novelId: string, chapterIndex: number, title: string): string {
  return persistentId128('chapter', [novelId, String(chapterIndex), title]);
}

export function parsedParagraphId(novelId: string, chapterId: string, paragraphIndex: number, text: string): string {
  return persistentId128('paragraph', [novelId, chapterId, String(paragraphIndex), text]);
}

export function paragraphPageId(novelId: string, chapterId: string, pageIndex: number): string {
  return persistentId128('page', [novelId, chapterId, String(pageIndex)]);
}

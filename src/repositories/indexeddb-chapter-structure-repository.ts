import type { Chapter, LabeledSegment, Novel, Paragraph, ParsedNovel, UserCorrection } from '../domain/types';
import { decodeNovelTextWithEncoding, normalizeNovelText } from '../domain/parser';
import {
  applyChapterStructureCommands,
  chapterStructureViews,
  type ChapterStructureCommand,
  type ChapterStructureSnapshot,
  type ChapterStructureTransformResult,
} from '@noveldesk/text-core/chapter-structure';
import {
  type ChapterStructureEditorState,
  type ChapterStructurePreview,
  type ChapterStructureReceipt,
  type ChapterStructureRepository,
  type ChapterStructureReviewItem,
} from './chapter-structure-repository';
import { getActiveBookSourceSnapshot } from '../storage/book-asset-store';
import { getBookmarks, getHighlights, getNotes } from '../storage/annotation-store';
import { getCorrections } from '../storage/analysis-artifact-store';
import { CHAPTER_STRUCTURE_STORES } from '../storage/chapter-structure-schema';
import { getRevisionChapters, getRevisionParagraphPages } from '../storage/content-revision-read-handle';
import type { ContentActivationReaderPlan } from '../storage/content-revision-store';
import { getNovel, saveImportedNovel } from '../storage/db';
import { requestToPromise, transactionDone } from '../storage/indexeddb-transaction';
import { openReaderDb } from '../storage/reader-database';

interface LoadedStructureSnapshot {
  readonly novel: Novel;
  readonly snapshot: ChapterStructureSnapshot;
  readonly source: Pick<NonNullable<Awaited<ReturnType<typeof getActiveBookSourceSnapshot>>>, 'metadata' | 'blob'>;
}

function randomId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function paragraphIds(paragraphs: readonly Paragraph[]): Set<string> {
  return new Set(paragraphs.map((paragraph) => paragraph.id));
}

function chapterIds(chapters: readonly Chapter[]): Set<string> {
  return new Set(chapters.map((chapter) => chapter.id));
}

async function loadStructureSnapshot(bookId: string, revisionId?: string): Promise<LoadedStructureSnapshot> {
  const active = await getActiveBookSourceSnapshot(bookId);
  const novel = active?.novel;
  const source = active ? { metadata: active.metadata, blob: active.blob } : undefined;
  if (!novel) throw new Error('책을 찾을 수 없습니다.');
  if (!source) throw new Error('구조 보정에는 보관된 source가 필요합니다. 원본을 다시 선택하거나 재구성하세요.');
  const contentRevisionId = revisionId ?? novel.activeContentRevisionId;
  if (!contentRevisionId) throw new Error('구조 보정에는 active content revision이 필요합니다.');
  const bytes = await source.blob.arrayBuffer();
  const decoded = decodeNovelTextWithEncoding(bytes, source.metadata.encoding ?? novel.sourceEncoding ?? 'auto');
  const sourceText = normalizeNovelText(decoded.text);
  const db = await openReaderDb();
  const chapters = await getRevisionChapters(db, contentRevisionId);
  const pages = (
    await Promise.all(chapters.map((chapter) => getRevisionParagraphPages(db, contentRevisionId, chapter.id)))
  ).flat();
  const paragraphs = pages
    .sort((left, right) => {
      const chapterOrder =
        chapters.findIndex((chapter) => chapter.id === left.chapterId) -
        chapters.findIndex((chapter) => chapter.id === right.chapterId);
      return chapterOrder || left.pageIndex - right.pageIndex;
    })
    .flatMap((page) => page.paragraphs)
    .sort((left, right) => {
      const chapterOrder =
        chapters.findIndex((chapter) => chapter.id === left.chapterId) -
        chapters.findIndex((chapter) => chapter.id === right.chapterId);
      return chapterOrder || left.index - right.index;
    });
  return {
    novel,
    source,
    snapshot: {
      bookId,
      bookTitle: novel.title,
      baseContentRevisionId: contentRevisionId,
      sourceText,
      chapters,
      paragraphs,
    },
  };
}

async function latestReceipt(bookId: string): Promise<ChapterStructureReceipt | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(CHAPTER_STRUCTURE_STORES.receipts, 'readonly');
  const rows = await requestToPromise<ChapterStructureReceipt[]>(
    tx.objectStore(CHAPTER_STRUCTURE_STORES.receipts).index('bookId').getAll(bookId),
  );
  await transactionDone(tx);
  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

async function reviewItemCount(bookId: string): Promise<number> {
  const db = await openReaderDb();
  const tx = db.transaction(CHAPTER_STRUCTURE_STORES.review, 'readonly');
  const count = await requestToPromise<number>(
    tx.objectStore(CHAPTER_STRUCTURE_STORES.review).index('bookId').count(bookId),
  );
  await transactionDone(tx);
  return count;
}

async function bookSegments(bookId: string): Promise<LabeledSegment[]> {
  const db = await openReaderDb();
  const tx = db.transaction('segments', 'readonly');
  const rows = await requestToPromise<LabeledSegment[]>(tx.objectStore('segments').index('novelId').getAll(bookId));
  await transactionDone(tx);
  return rows;
}

async function annotationRisk(bookId: string, removedParagraphIds: ReadonlySet<string>): Promise<number> {
  const [bookmarks, highlights, notes] = await Promise.all([
    getBookmarks(bookId),
    getHighlights(bookId),
    getNotes(bookId),
  ]);
  return [...bookmarks, ...highlights, ...notes].filter(
    (item) => item.paragraphId && removedParagraphIds.has(item.paragraphId),
  ).length;
}

function buildArtifactPlan(
  oldSnapshot: ChapterStructureSnapshot,
  transformed: ChapterStructureTransformResult,
  receiptId: string,
  segments: readonly LabeledSegment[],
  corrections: readonly UserCorrection[],
  clearVoiceProductState: boolean,
): Pick<
  ContentActivationReaderPlan,
  | 'segments'
  | 'deleteSegmentIds'
  | 'corrections'
  | 'deleteCorrectionIds'
  | 'structureReviewItems'
  | 'clearVoiceProductState'
> {
  const nextParagraphs = new Map(transformed.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const nextChapters = chapterIds(transformed.chapters);
  const mappedSegments: LabeledSegment[] = [];
  const deleteSegmentIds: string[] = [];
  for (const segment of segments) {
    const paragraph = nextParagraphs.get(segment.paragraphId);
    if (paragraph) mappedSegments.push({ ...segment, chapterId: paragraph.chapterId });
    else deleteSegmentIds.push(segment.id);
  }

  const mappedCorrections: UserCorrection[] = [];
  const deleteCorrectionIds: string[] = [];
  const structureReviewItems: ChapterStructureReviewItem[] = [];
  const now = new Date().toISOString();
  for (const correction of corrections) {
    const paragraph = correction.paragraphId ? nextParagraphs.get(correction.paragraphId) : undefined;
    if (paragraph || (!correction.paragraphId && nextChapters.has(correction.chapterId))) {
      mappedCorrections.push({ ...correction, chapterId: paragraph?.chapterId ?? correction.chapterId });
      continue;
    }
    deleteCorrectionIds.push(correction.id);
    structureReviewItems.push({
      id: randomId('chapter_structure_review'),
      bookId: oldSnapshot.bookId,
      receiptId,
      kind: 'correction_unmapped',
      correction,
      createdAt: now,
    });
  }
  return {
    segments: mappedSegments,
    deleteSegmentIds,
    corrections: mappedCorrections,
    deleteCorrectionIds,
    structureReviewItems,
    clearVoiceProductState,
  };
}

function parsedNovel(
  loaded: LoadedStructureSnapshot,
  transformed: ChapterStructureTransformResult,
  needsReview: boolean,
): ParsedNovel {
  const now = new Date().toISOString();
  return {
    novel: {
      ...loaded.novel,
      rawText: '',
      normalizedText: '',
      updatedAt: now,
      totalChapters: transformed.chapters.length,
      totalParagraphs: transformed.paragraphs.length,
      analysisStatus: needsReview ? 'needs_review' : loaded.novel.analysisStatus,
    },
    chapters: transformed.chapters,
    paragraphs: transformed.paragraphs,
  };
}

async function activateStructure(
  loaded: LoadedStructureSnapshot,
  transformed: ChapterStructureTransformResult,
  receiptId: string,
  structuralChange: boolean,
): Promise<string> {
  const [segments, corrections] = await Promise.all([bookSegments(loaded.novel.id), getCorrections(loaded.novel.id)]);
  const artifactPlan = buildArtifactPlan(
    loaded.snapshot,
    transformed,
    receiptId,
    segments,
    corrections,
    structuralChange,
  );
  const needsReview =
    structuralChange &&
    (segments.length > 0 || corrections.length > 0 || loaded.novel.analysisStatus !== 'not_analyzed');
  await saveImportedNovel(parsedNovel(loaded, transformed, needsReview), {
    sourceAsset: {
      blob: loaded.source.blob,
      fileName: loaded.source.metadata.fileName ?? loaded.novel.sourceFileName,
      contentType: loaded.source.metadata.contentType,
      contentHash: loaded.source.metadata.contentHash,
      encoding: loaded.source.metadata.encoding,
      provenance:
        loaded.source.metadata.provenance === 'canonical_reconstruction' ? 'canonical_reconstruction' : 'original',
    },
    extendReaderPlan: (plan) => ({ ...plan, ...artifactPlan }),
  });
  const next = await getNovel(loaded.novel.id);
  if (!next?.activeContentRevisionId || next.activeContentRevisionId === loaded.snapshot.baseContentRevisionId) {
    throw new Error('구조 보정 revision이 활성화되지 않았습니다.');
  }
  return next.activeContentRevisionId;
}

async function saveDraft(preview: ChapterStructurePreview): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(CHAPTER_STRUCTURE_STORES.drafts, 'readwrite');
  tx.objectStore(CHAPTER_STRUCTURE_STORES.drafts).put(preview);
  await transactionDone(tx);
}

async function loadDraft(draftId: string): Promise<ChapterStructurePreview | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(CHAPTER_STRUCTURE_STORES.drafts, 'readonly');
  const draft = await requestToPromise<ChapterStructurePreview | undefined>(
    tx.objectStore(CHAPTER_STRUCTURE_STORES.drafts).get(draftId),
  );
  await transactionDone(tx);
  return draft;
}

async function loadReceipt(receiptId: string): Promise<ChapterStructureReceipt | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(CHAPTER_STRUCTURE_STORES.receipts, 'readonly');
  const receipt = await requestToPromise<ChapterStructureReceipt | undefined>(
    tx.objectStore(CHAPTER_STRUCTURE_STORES.receipts).get(receiptId),
  );
  await transactionDone(tx);
  return receipt;
}

export class IndexedDbChapterStructureRepository implements ChapterStructureRepository {
  async getEditorState(bookId: string): Promise<ChapterStructureEditorState> {
    const loaded = await loadStructureSnapshot(bookId);
    const [receipt, reviewCount] = await Promise.all([latestReceipt(bookId), reviewItemCount(bookId)]);
    return {
      bookId,
      baseContentRevisionId: loaded.snapshot.baseContentRevisionId,
      sourceProvenance:
        loaded.source.metadata.provenance === 'canonical_reconstruction' ? 'canonical_reconstruction' : 'original',
      chapters: chapterStructureViews(loaded.snapshot),
      latestReceipt: receipt,
      reviewItemCount: reviewCount,
    };
  }

  async preview(bookId: string, commands: readonly ChapterStructureCommand[]): Promise<ChapterStructurePreview> {
    if (commands.length === 0) throw new Error('적용할 구조 보정 명령이 없습니다.');
    const loaded = await loadStructureSnapshot(bookId);
    const transformed = applyChapterStructureCommands(loaded.snapshot, commands);
    const beforeIds = paragraphIds(loaded.snapshot.paragraphs);
    const afterIds = paragraphIds(transformed.paragraphs);
    const removed = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
    const corrections = await getCorrections(bookId);
    const now = new Date().toISOString();
    const preview: ChapterStructurePreview = {
      draftId: randomId('chapter_structure_draft'),
      bookId,
      baseContentRevisionId: loaded.snapshot.baseContentRevisionId,
      commands: [...commands],
      before: chapterStructureViews(loaded.snapshot),
      after: chapterStructureViews({
        ...loaded.snapshot,
        chapters: transformed.chapters,
        paragraphs: transformed.paragraphs,
      }),
      affectedChapterIds: transformed.affectedChapterIds,
      impact: {
        preservedParagraphs: [...beforeIds].filter((id) => afterIds.has(id)).length,
        addedParagraphs: [...afterIds].filter((id) => !beforeIds.has(id)).length,
        removedParagraphs: removed.size,
        readerAnnotationsAtRisk: await annotationRisk(bookId, removed),
        correctionsForReview: corrections.filter(
          (correction) => correction.paragraphId && removed.has(correction.paragraphId),
        ).length,
      },
      warnings:
        loaded.source.metadata.provenance === 'canonical_reconstruction'
          ? ['원본이 아닌 재구성 source를 기준으로 구조를 보정합니다.']
          : [],
      createdAt: now,
    };
    await saveDraft(preview);
    return preview;
  }

  async apply(draftId: string): Promise<ChapterStructureReceipt> {
    const draft = await loadDraft(draftId);
    if (!draft) throw new Error('구조 보정 draft를 찾을 수 없습니다.');
    const loaded = await loadStructureSnapshot(draft.bookId);
    if (loaded.snapshot.baseContentRevisionId !== draft.baseContentRevisionId) {
      throw new Error('본문 revision이 변경되었습니다. 새 preview를 만드세요.');
    }
    const transformed = applyChapterStructureCommands(loaded.snapshot, draft.commands);
    const receiptId = randomId('chapter_structure_receipt');
    const structuralChange = draft.commands.some((command) => command.kind !== 'rename');
    const contentRevisionId = await activateStructure(loaded, transformed, receiptId, structuralChange);
    const receipt: ChapterStructureReceipt = {
      id: receiptId,
      bookId: draft.bookId,
      draftId,
      previousContentRevisionId: draft.baseContentRevisionId,
      contentRevisionId,
      commands: draft.commands,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    const db = await openReaderDb();
    const tx = db.transaction([CHAPTER_STRUCTURE_STORES.drafts, CHAPTER_STRUCTURE_STORES.receipts], 'readwrite');
    tx.objectStore(CHAPTER_STRUCTURE_STORES.receipts).put(receipt);
    tx.objectStore(CHAPTER_STRUCTURE_STORES.drafts).delete(draftId);
    await transactionDone(tx);
    return receipt;
  }

  async rollback(receiptId: string): Promise<ChapterStructureReceipt> {
    const receipt = await loadReceipt(receiptId);
    if (!receipt || receipt.status !== 'active') throw new Error('되돌릴 구조 보정 기록을 찾을 수 없습니다.');
    const current = await loadStructureSnapshot(receipt.bookId);
    if (current.snapshot.baseContentRevisionId !== receipt.contentRevisionId) {
      throw new Error('후속 본문 revision이 있어 이 기록을 바로 되돌릴 수 없습니다.');
    }
    const previous = await loadStructureSnapshot(receipt.bookId, receipt.previousContentRevisionId);
    const transformed: ChapterStructureTransformResult = {
      chapters: [...previous.snapshot.chapters],
      paragraphs: [...previous.snapshot.paragraphs],
      affectedChapterIds: [
        ...new Set([...current.snapshot.chapters, ...previous.snapshot.chapters].map((chapter) => chapter.id)),
      ],
    };
    const rollbackContentRevisionId = await activateStructure(current, transformed, receipt.id, true);
    const updated: ChapterStructureReceipt = {
      ...receipt,
      status: 'rolled_back',
      rolledBackAt: new Date().toISOString(),
      rollbackContentRevisionId,
    };
    const db = await openReaderDb();
    const tx = db.transaction(CHAPTER_STRUCTURE_STORES.receipts, 'readwrite');
    tx.objectStore(CHAPTER_STRUCTURE_STORES.receipts).put(updated);
    await transactionDone(tx);
    return updated;
  }

  async listReviewItems(bookId: string): Promise<readonly ChapterStructureReviewItem[]> {
    const db = await openReaderDb();
    const tx = db.transaction(CHAPTER_STRUCTURE_STORES.review, 'readonly');
    const rows = await requestToPromise<ChapterStructureReviewItem[]>(
      tx.objectStore(CHAPTER_STRUCTURE_STORES.review).index('bookId').getAll(bookId),
    );
    await transactionDone(tx);
    return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

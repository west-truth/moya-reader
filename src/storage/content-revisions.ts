import { hashSync } from '../domain/hash';
import { integrityHash, integrityHashVersion } from '../domain/id-hash-contract';
import type { Chapter, Novel, ParagraphPage } from '../domain/types';

export type BookContentRevisionSource = 'local_import' | 'remote_snapshot';
export type BookContentRevisionStatus = 'staging' | 'active' | 'superseded';

export interface ContentRevisionCounts {
  chapterCount: number;
  pageCount: number;
  paragraphCount: number;
}

export interface ContentRevisionExpectedCounts {
  chapterCount: number;
  pageCount?: number;
  paragraphCount: number;
}

export interface StoredContentRevisionCounts extends ContentRevisionCounts {
  paragraphRefCount: number;
  searchRowCount: number;
}

export interface BookContentRevisionRecord {
  id: string;
  novelId: string;
  status: BookContentRevisionStatus;
  source: BookContentRevisionSource;
  sourceRevision?: string;
  sourceHash?: string;
  normalizedHash?: string;
  baseActiveRevisionId?: string;
  baseNovelPresent: boolean;
  expected: ContentRevisionExpectedCounts;
  actual?: StoredContentRevisionCounts;
  createdAt: string;
  activatedAt?: string;
}

export class ContentRevisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRevisionValidationError';
  }
}

export class ContentRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRevisionConflictError';
  }
}

interface ChapterValidationState {
  expectedParagraphCount: number;
  nextPageIndex: number;
  nextParagraphIndex: number;
  actualParagraphCount: number;
}

export interface ContentRevisionValidationState {
  readonly novelId: string;
  readonly expected: ContentRevisionExpectedCounts;
  readonly chapterById: Map<string, ChapterValidationState>;
  readonly pageIds: Set<string>;
  readonly paragraphIds: Set<string>;
  pageCount: number;
  paragraphCount: number;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContentRevisionValidationError(`${label} must be a non-negative integer`);
  }
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new ContentRevisionValidationError(`${label} mismatch: expected ${expected}, received ${actual}`);
  }
}

function verifiablePageHash(page: ParagraphPage): string | undefined {
  const paragraphHashes = page.paragraphs.map((paragraph) => paragraph.textHash);
  const version = integrityHashVersion(page.textHash);
  if (version === 'v2-sha256-tagged') return integrityHash(JSON.stringify(paragraphHashes));
  if (version === 'v1-sha256') return integrityHash(JSON.stringify(paragraphHashes)).slice('sha256:'.length);
  if (version === 'v1-fnv32' && paragraphHashes.every((hash) => /^[0-9a-f]{8}$/i.test(hash))) {
    return hashSync(paragraphHashes.join(':'));
  }
  return undefined;
}

export function createContentRevisionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `content_revision_${globalThis.crypto.randomUUID()}`;
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure randomness is unavailable for content revision IDs');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const random = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `content_revision_${random}`;
}

export function revisionScopedStorageId(contentRevisionId: string, domainId: string): string {
  return JSON.stringify([contentRevisionId, domainId]);
}

export function createContentRevisionValidationState(input: {
  novel: Novel;
  chapters: Chapter[];
  expected: ContentRevisionExpectedCounts;
  contentHash?: string;
}): ContentRevisionValidationState {
  const { novel, chapters, expected } = input;
  assertNonNegativeInteger(expected.chapterCount, 'expected chapter count');
  if (expected.pageCount !== undefined) {
    assertNonNegativeInteger(expected.pageCount, 'expected page count');
  }
  assertNonNegativeInteger(expected.paragraphCount, 'expected paragraph count');
  assertEqual(chapters.length, expected.chapterCount, 'chapter count');

  if (input.contentHash && novel.normalizedTextHash && input.contentHash !== novel.normalizedTextHash) {
    throw new ContentRevisionValidationError('snapshot content hash does not match novel metadata');
  }

  const chapterById = new Map<string, ChapterValidationState>();
  let declaredParagraphCount = 0;
  chapters.forEach((chapter, offset) => {
    if (chapter.novelId !== novel.id) {
      throw new ContentRevisionValidationError(`chapter ${chapter.id} belongs to another novel`);
    }
    if (chapterById.has(chapter.id)) {
      throw new ContentRevisionValidationError(`duplicate chapter ID ${chapter.id}`);
    }
    if (chapter.index !== offset + 1) {
      throw new ContentRevisionValidationError(`chapter index continuity mismatch at ${chapter.id}`);
    }
    assertNonNegativeInteger(chapter.paragraphCount, `chapter ${chapter.id} paragraph count`);
    declaredParagraphCount += chapter.paragraphCount;
    chapterById.set(chapter.id, {
      expectedParagraphCount: chapter.paragraphCount,
      nextPageIndex: 0,
      nextParagraphIndex: 1,
      actualParagraphCount: 0,
    });
  });
  assertEqual(declaredParagraphCount, expected.paragraphCount, 'declared paragraph count');

  return {
    novelId: novel.id,
    expected,
    chapterById,
    pageIds: new Set(),
    paragraphIds: new Set(),
    pageCount: 0,
    paragraphCount: 0,
  };
}

export function validateContentRevisionPageBatch(state: ContentRevisionValidationState, pages: ParagraphPage[]): void {
  for (const page of pages) {
    if (page.novelId !== state.novelId) {
      throw new ContentRevisionValidationError(`page ${page.id} belongs to another novel`);
    }
    const chapter = state.chapterById.get(page.chapterId);
    if (!chapter) {
      throw new ContentRevisionValidationError(`page ${page.id} belongs to an unknown chapter`);
    }
    if (state.pageIds.has(page.id)) {
      throw new ContentRevisionValidationError(`duplicate page ID ${page.id}`);
    }
    if (page.pageIndex !== chapter.nextPageIndex) {
      throw new ContentRevisionValidationError(`page index continuity mismatch at ${page.id}`);
    }
    if (!page.paragraphs.length) {
      throw new ContentRevisionValidationError(`page ${page.id} has no paragraphs`);
    }
    if (page.startParagraphIndex !== chapter.nextParagraphIndex) {
      throw new ContentRevisionValidationError(`page start continuity mismatch at ${page.id}`);
    }

    let nextParagraphIndex = chapter.nextParagraphIndex;
    for (const paragraph of page.paragraphs) {
      if (paragraph.novelId !== state.novelId || paragraph.chapterId !== page.chapterId) {
        throw new ContentRevisionValidationError(`paragraph ${paragraph.id} has invalid ownership`);
      }
      if (state.paragraphIds.has(paragraph.id)) {
        throw new ContentRevisionValidationError(`duplicate paragraph ID ${paragraph.id}`);
      }
      if (paragraph.index !== nextParagraphIndex) {
        throw new ContentRevisionValidationError(`paragraph index continuity mismatch at ${paragraph.id}`);
      }
      state.paragraphIds.add(paragraph.id);
      nextParagraphIndex += 1;
    }

    const expectedEndIndex = nextParagraphIndex - 1;
    if (page.endParagraphIndex !== expectedEndIndex) {
      throw new ContentRevisionValidationError(`page end continuity mismatch at ${page.id}`);
    }
    const calculatedHash = verifiablePageHash(page);
    if (calculatedHash && calculatedHash !== page.textHash.toLowerCase()) {
      throw new ContentRevisionValidationError(`page hash mismatch at ${page.id}`);
    }

    chapter.nextPageIndex += 1;
    chapter.nextParagraphIndex = nextParagraphIndex;
    chapter.actualParagraphCount += page.paragraphs.length;
    if (chapter.actualParagraphCount > chapter.expectedParagraphCount) {
      throw new ContentRevisionValidationError(`chapter ${page.chapterId} contains too many paragraphs`);
    }
    state.pageIds.add(page.id);
    state.pageCount += 1;
    state.paragraphCount += page.paragraphs.length;
  }
}

export function finalizeContentRevisionValidation(state: ContentRevisionValidationState): StoredContentRevisionCounts {
  if (state.expected.pageCount !== undefined) {
    assertEqual(state.pageCount, state.expected.pageCount, 'page count');
  }
  assertEqual(state.paragraphCount, state.expected.paragraphCount, 'paragraph count');
  for (const [chapterId, chapter] of state.chapterById) {
    assertEqual(chapter.actualParagraphCount, chapter.expectedParagraphCount, `chapter ${chapterId} paragraph count`);
  }
  return {
    chapterCount: state.chapterById.size,
    pageCount: state.pageCount,
    paragraphCount: state.paragraphCount,
    paragraphRefCount: state.paragraphCount,
    searchRowCount: state.paragraphCount,
  };
}

export function validateStoredContentRevisionCounts(
  expected: StoredContentRevisionCounts,
  actual: StoredContentRevisionCounts,
): void {
  assertEqual(actual.chapterCount, expected.chapterCount, 'stored chapter count');
  assertEqual(actual.pageCount, expected.pageCount, 'stored page count');
  assertEqual(actual.paragraphCount, expected.paragraphCount, 'stored paragraph count');
  assertEqual(actual.paragraphRefCount, expected.paragraphRefCount, 'stored paragraph ref count');
  assertEqual(actual.searchRowCount, expected.searchRowCount, 'stored search row count');
}

export function assertContentRevisionBase(revision: BookContentRevisionRecord, currentNovel: Novel | undefined): void {
  if (revision.baseNovelPresent !== Boolean(currentNovel)) {
    throw new ContentRevisionConflictError('book existence changed while content was staged');
  }
  if (revision.baseActiveRevisionId !== currentNovel?.activeContentRevisionId) {
    throw new ContentRevisionConflictError('active content revision changed while content was staged');
  }
}

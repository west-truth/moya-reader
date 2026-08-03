import { integrityHash } from '../../domain/id-hash-contract';
import { parsedChapterId, parsedParagraphId, paragraphPageId } from '../../domain/parser/entity-identities';
import type { Chapter, Novel, Paragraph, ParagraphPage } from '../../domain/types';
import type { BookContentRevisionRecord } from '../content-revisions';
import { contentDomainHeadId, type ContentDomainHead } from '../content-revision-store';
import type { IdV2BookSource, IdV2SourceRecord } from './contracts';
import { IdV2MigrationValidationError } from './errors';
import { canonicalPageHash, canonicalStoredHash, reconstructChapterText, verifyLegacyPageHash } from './hashes';
import { IdV2MappingRegistry, migrationEntityId } from './mapping-registry';
import { IdV2PlanAccumulator } from './plan-accumulator';

const LEGACY_SCOPE = 'legacy';

interface ContentScope {
  scope: string;
  mappedRevisionId?: string;
  chapterStore: 'chapters' | 'book_content_chapters';
  paragraphStore: 'paragraphs' | 'book_content_paragraphs';
  pageStore: 'paragraph_pages' | 'book_content_paragraph_pages';
  searchStore: 'paragraph_search' | 'book_content_paragraph_search';
  chapters: Record<string, unknown>[];
  paragraphRefs: Record<string, unknown>[];
  pages: Record<string, unknown>[];
}

function records(source: IdV2BookSource, storeName: string): IdV2SourceRecord[] {
  return source.records.filter((record) => record.storeName === storeName);
}

function values(source: IdV2BookSource, storeName: string): Record<string, unknown>[] {
  return records(source, storeName).map((record) => record.value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asParagraph(value: unknown): Paragraph {
  return value as Paragraph;
}

function scopeRows(rows: Record<string, unknown>[], contentRevisionId: string): Record<string, unknown>[] {
  return rows.filter((row) => row.contentRevisionId === contentRevisionId);
}

function createScopes(source: IdV2BookSource, revisionMappings: Map<string, string>): ContentScope[] {
  const scopes: ContentScope[] = [
    {
      scope: LEGACY_SCOPE,
      chapterStore: 'chapters',
      paragraphStore: 'paragraphs',
      pageStore: 'paragraph_pages',
      searchStore: 'paragraph_search',
      chapters: values(source, 'chapters'),
      paragraphRefs: values(source, 'paragraphs'),
      pages: values(source, 'paragraph_pages'),
    },
  ];
  const chapterRows = values(source, 'book_content_chapters');
  const paragraphRows = values(source, 'book_content_paragraphs');
  const pageRows = values(source, 'book_content_paragraph_pages');
  revisionMappings.forEach((mappedRevisionId, oldRevisionId) => {
    scopes.push({
      scope: oldRevisionId,
      mappedRevisionId,
      chapterStore: 'book_content_chapters',
      paragraphStore: 'book_content_paragraphs',
      pageStore: 'book_content_paragraph_pages',
      searchStore: 'book_content_paragraph_search',
      chapters: scopeRows(chapterRows, oldRevisionId),
      paragraphRefs: scopeRows(paragraphRows, oldRevisionId),
      pages: scopeRows(pageRows, oldRevisionId),
    });
  });
  return scopes.filter((scope) => scope.chapters.length || scope.pages.length || scope.paragraphRefs.length);
}

function paragraphsFromScope(scope: ContentScope): Map<string, Paragraph> {
  const byId = new Map<string, Paragraph>();
  const add = (paragraph: Paragraph) => {
    const existing = byId.get(paragraph.id);
    if (
      existing &&
      (existing.text !== paragraph.text ||
        existing.chapterId !== paragraph.chapterId ||
        existing.index !== paragraph.index)
    ) {
      throw new IdV2MigrationValidationError(
        'legacy_id_collision',
        `Paragraph ID ${paragraph.id} identifies different source paragraphs`,
        'paragraph',
        paragraph.id,
      );
    }
    byId.set(paragraph.id, paragraph);
  };
  for (const page of scope.pages) {
    const pageParagraphs = Array.isArray(page.paragraphs) ? page.paragraphs : [];
    pageParagraphs.forEach((paragraph) => add(asParagraph(paragraph)));
  }
  for (const ref of scope.paragraphRefs) {
    if (typeof ref.text === 'string' && ref.text) add(asParagraph(ref));
  }
  return byId;
}

function canonicalParagraph(
  paragraph: Paragraph,
  newNovelId: string,
  newChapterId: string,
  registry: IdV2MappingRegistry,
  scope: string,
  canonicalScope: boolean,
): Paragraph {
  const newId = parsedParagraphId(newNovelId, newChapterId, Math.max(0, paragraph.index - 1), paragraph.text);
  registry.add('paragraph', paragraph.id, newId, scope);
  if (canonicalScope) registry.add('paragraph', paragraph.id, newId);
  return {
    ...paragraph,
    id: newId,
    novelId: newNovelId,
    chapterId: newChapterId,
    textHash: canonicalStoredHash(
      paragraph.textHash,
      paragraph.text,
      `Paragraph ${paragraph.id}`,
      'paragraph',
      paragraph.id,
    ),
  };
}

function paragraphRef(paragraph: Paragraph, pageIndex: number): Record<string, unknown> {
  return { ...paragraph, pageIndex, text: '', textStorageMode: 'page' };
}

function searchRow(page: ParagraphPage, paragraph: Paragraph): Record<string, unknown> {
  return {
    id: `search_${page.id}_${paragraph.index}`,
    novelId: paragraph.novelId,
    chapterId: paragraph.chapterId,
    paragraphId: paragraph.id,
    pageId: page.id,
    pageIndex: page.pageIndex,
    paragraphIndex: paragraph.index,
    textLower: paragraph.text.toLocaleLowerCase(),
    paragraph,
  };
}

async function targetScopeContent(input: {
  scope: ContentScope;
  canonicalScope: boolean;
  oldNovelId: string;
  newNovelId: string;
  registry: IdV2MappingRegistry;
  accumulator: IdV2PlanAccumulator;
  yieldControl?: () => Promise<void>;
}): Promise<{ chapterCount: number; paragraphCount: number; chapterIds: string[]; paragraphIds: string[] }> {
  const { scope, canonicalScope, newNovelId, registry, accumulator } = input;
  const sourceParagraphs = paragraphsFromScope(scope);
  const paragraphsByChapter = new Map<string, Paragraph[]>();
  sourceParagraphs.forEach((paragraph) => {
    const group = paragraphsByChapter.get(paragraph.chapterId) ?? [];
    group.push(paragraph);
    paragraphsByChapter.set(paragraph.chapterId, group);
  });
  paragraphsByChapter.forEach((group) => group.sort((left, right) => left.index - right.index));

  const newChapterByOldId = new Map<string, Chapter>();
  const orderedChapters = scope.chapters
    .map((row) => row as unknown as Chapter)
    .sort((left, right) => left.index - right.index);
  for (const [offset, chapter] of orderedChapters.entries()) {
    if (chapter.novelId !== input.oldNovelId || chapter.index !== offset + 1) {
      throw new IdV2MigrationValidationError(
        'chapter_ownership_or_order',
        `Chapter ${chapter.id} has invalid ownership or sequence`,
        'chapter',
        chapter.id,
      );
    }
    const newChapterId = parsedChapterId(newNovelId, chapter.index, chapter.title);
    registry.add('chapter', chapter.id, newChapterId, scope.scope);
    if (canonicalScope) registry.add('chapter', chapter.id, newChapterId);
    const oldParagraphs = paragraphsByChapter.get(chapter.id) ?? [];
    const sourceText = chapter.normalizedText || reconstructChapterText(oldParagraphs, chapter.characterCount);
    const nextChapter: Chapter = {
      ...chapter,
      id: newChapterId,
      novelId: newNovelId,
      normalizedText: '',
      textHash: canonicalStoredHash(chapter.textHash, sourceText, `Chapter ${chapter.id}`, 'chapter', chapter.id),
    };
    newChapterByOldId.set(chapter.id, nextChapter);
    const value: Record<string, unknown> = { ...nextChapter };
    const key = scope.mappedRevisionId ? JSON.stringify([scope.mappedRevisionId, newChapterId]) : newChapterId;
    if (scope.mappedRevisionId) {
      value.storageId = key;
      value.contentRevisionId = scope.mappedRevisionId;
    }
    accumulator.target(scope.chapterStore, key, value);
    await input.yieldControl?.();
  }

  const canonicalParagraphByOldId = new Map<string, Paragraph>();
  let paragraphOffset = 0;
  for (const [oldId, paragraph] of sourceParagraphs) {
    const chapter = newChapterByOldId.get(paragraph.chapterId);
    if (!chapter) {
      throw new IdV2MigrationValidationError(
        'missing_chapter',
        `Paragraph ${oldId} has no chapter`,
        'paragraph',
        oldId,
      );
    }
    canonicalParagraphByOldId.set(
      oldId,
      canonicalParagraph(paragraph, newNovelId, chapter.id, registry, scope.scope, canonicalScope),
    );
    paragraphOffset += 1;
    if (paragraphOffset % 32 === 0) await input.yieldControl?.();
  }

  const pageIndexesByChapter = new Map<string, number>();
  const paragraphIds = new Set<string>();
  const orderedPages = [...scope.pages].sort(
    (left, right) =>
      stringValue(left.chapterId).localeCompare(stringValue(right.chapterId)) ||
      numberValue(left.pageIndex) - numberValue(right.pageIndex),
  );
  for (const row of orderedPages) {
    const oldPage = row as unknown as ParagraphPage;
    const nextChapter = newChapterByOldId.get(oldPage.chapterId);
    if (!nextChapter) {
      throw new IdV2MigrationValidationError(
        'missing_chapter',
        `Page ${oldPage.id} has no chapter`,
        'page',
        oldPage.id,
      );
    }
    const expectedPageIndex = pageIndexesByChapter.get(oldPage.chapterId) ?? 0;
    if (oldPage.pageIndex !== expectedPageIndex) {
      throw new IdV2MigrationValidationError(
        'page_sequence',
        `Page ${oldPage.id} is not contiguous`,
        'page',
        oldPage.id,
      );
    }
    pageIndexesByChapter.set(oldPage.chapterId, expectedPageIndex + 1);
    verifyLegacyPageHash(oldPage.textHash, oldPage.paragraphs, oldPage.id);
    const paragraphs = oldPage.paragraphs.map((paragraph) => {
      const mapped = canonicalParagraphByOldId.get(paragraph.id);
      if (!mapped) {
        throw new IdV2MigrationValidationError(
          'missing_paragraph',
          `Page ${oldPage.id} references unknown paragraph ${paragraph.id}`,
          'paragraph',
          paragraph.id,
        );
      }
      paragraphIds.add(mapped.id);
      return mapped;
    });
    const newPageId = paragraphPageId(newNovelId, nextChapter.id, oldPage.pageIndex);
    registry.add('page', oldPage.id, newPageId, scope.scope);
    if (canonicalScope) registry.add('page', oldPage.id, newPageId);
    const page: ParagraphPage = {
      ...oldPage,
      id: newPageId,
      novelId: newNovelId,
      chapterId: nextChapter.id,
      paragraphs,
      textHash: canonicalPageHash(paragraphs),
    };
    const pageKey = scope.mappedRevisionId ? JSON.stringify([scope.mappedRevisionId, newPageId]) : newPageId;
    const pageValue: Record<string, unknown> = { ...page };
    if (scope.mappedRevisionId) {
      pageValue.storageId = pageKey;
      pageValue.contentRevisionId = scope.mappedRevisionId;
    }
    accumulator.target(scope.pageStore, pageKey, pageValue);

    paragraphs.forEach((paragraph) => {
      const ref = paragraphRef(paragraph, page.pageIndex);
      const refKey = scope.mappedRevisionId ? JSON.stringify([scope.mappedRevisionId, paragraph.id]) : paragraph.id;
      if (scope.mappedRevisionId) {
        ref.storageId = refKey;
        ref.contentRevisionId = scope.mappedRevisionId;
      }
      accumulator.target(scope.paragraphStore, refKey, ref);

      const nextSearch = searchRow(page, paragraph);
      const oldSearchId = `search_${oldPage.id}_${paragraph.index}`;
      registry.add('search_row', oldSearchId, stringValue(nextSearch.id), scope.scope);
      const searchKey = scope.mappedRevisionId
        ? JSON.stringify([scope.mappedRevisionId, nextSearch.id])
        : stringValue(nextSearch.id);
      if (scope.mappedRevisionId) {
        nextSearch.storageId = searchKey;
        nextSearch.contentRevisionId = scope.mappedRevisionId;
      }
      accumulator.target(scope.searchStore, searchKey, nextSearch);
    });
    await input.yieldControl?.();
  }

  if (sourceParagraphs.size !== paragraphIds.size) {
    throw new IdV2MigrationValidationError(
      'paragraph_page_coverage',
      `Scope ${scope.scope} has paragraphs not covered by pages`,
      'book',
    );
  }
  return {
    chapterCount: orderedChapters.length,
    paragraphCount: paragraphIds.size,
    chapterIds: Array.from(newChapterByOldId.values()).map((chapter) => chapter.id),
    paragraphIds: Array.from(paragraphIds),
  };
}

function canonicalOptionalRevisionHash(
  value: unknown,
  source: Novel,
  rawHash: string,
  normalizedHash: string,
  label: string,
): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value === source.rawTextHash) return rawHash;
  if (value === source.normalizedTextHash) return normalizedHash;
  return canonicalStoredHash(value, undefined, label, 'book', source.id);
}

export async function addContentPlan(input: {
  source: IdV2BookSource;
  newNovelId: string;
  normalizedHash: string;
  rawHash: string;
  registry: IdV2MappingRegistry;
  accumulator: IdV2PlanAccumulator;
  yieldControl?: () => Promise<void>;
}): Promise<Novel> {
  const { source, newNovelId, normalizedHash, rawHash, registry, accumulator } = input;
  const oldNovel = source.novel;
  const revisionMappings = new Map<string, string>();
  const revisionRows = values(source, 'book_content_revisions') as unknown as BookContentRevisionRecord[];
  revisionRows.forEach((revision) => {
    const nextId = migrationEntityId('content_revision', newNovelId, revision.id);
    revisionMappings.set(revision.id, nextId);
    registry.add('content_revision', revision.id, nextId);
  });

  const canonicalScope = oldNovel.activeContentRevisionId || LEGACY_SCOPE;
  const scopes = createScopes(source, revisionMappings);
  let canonicalCounts:
    { chapterCount: number; paragraphCount: number; chapterIds: string[]; paragraphIds: string[] } | undefined;
  for (const scope of scopes) {
    const counts = await targetScopeContent({
      scope,
      canonicalScope: scope.scope === canonicalScope,
      oldNovelId: oldNovel.id,
      newNovelId,
      registry,
      accumulator,
      yieldControl: input.yieldControl,
    });
    if (scope.scope === canonicalScope) canonicalCounts = counts;
    await input.yieldControl?.();
  }

  if (!canonicalCounts && (oldNovel.totalChapters > 0 || oldNovel.totalParagraphs > 0)) {
    throw new IdV2MigrationValidationError('missing_active_content', 'The active book content cannot be reconstructed');
  }
  if (
    canonicalCounts &&
    (canonicalCounts.chapterCount !== oldNovel.totalChapters ||
      canonicalCounts.paragraphCount !== oldNovel.totalParagraphs)
  ) {
    throw new IdV2MigrationValidationError(
      'content_count_mismatch',
      'Book metadata does not match active content counts',
    );
  }

  revisionRows.forEach((revision) => {
    const nextId = revisionMappings.get(revision.id)!;
    const next: BookContentRevisionRecord = {
      ...revision,
      id: nextId,
      novelId: newNovelId,
      baseActiveRevisionId: revision.baseActiveRevisionId
        ? revisionMappings.get(revision.baseActiveRevisionId)
        : undefined,
      sourceHash: canonicalOptionalRevisionHash(
        revision.sourceHash,
        oldNovel,
        rawHash,
        normalizedHash,
        `Content revision ${revision.id} source hash`,
      ),
      normalizedHash: canonicalOptionalRevisionHash(
        revision.normalizedHash,
        oldNovel,
        rawHash,
        normalizedHash,
        `Content revision ${revision.id} normalized hash`,
      ),
    };
    accumulator.target('book_content_revisions', next.id, next as unknown as Record<string, unknown>);
  });

  const mappedActiveRevision = oldNovel.activeContentRevisionId
    ? registry.require('content_revision', oldNovel.activeContentRevisionId)
    : undefined;
  if (mappedActiveRevision && canonicalCounts) {
    for (const domainId of canonicalCounts.chapterIds) {
      const head: ContentDomainHead = {
        id: contentDomainHeadId('chapter', domainId),
        entityType: 'chapter',
        domainId,
        novelId: newNovelId,
        contentRevisionId: mappedActiveRevision,
      };
      accumulator.target('book_content_domain_heads', head.id, head as unknown as Record<string, unknown>);
    }
    for (const [index, domainId] of canonicalCounts.paragraphIds.entries()) {
      const head: ContentDomainHead = {
        id: contentDomainHeadId('paragraph', domainId),
        entityType: 'paragraph',
        domainId,
        novelId: newNovelId,
        contentRevisionId: mappedActiveRevision,
      };
      accumulator.target('book_content_domain_heads', head.id, head as unknown as Record<string, unknown>);
      if ((index + 1) % 32 === 0) await input.yieldControl?.();
    }
  }

  const lastReadChapterId = oldNovel.lastReadChapterId
    ? registry.require('chapter', oldNovel.lastReadChapterId)
    : undefined;
  const lastReadParagraphId = oldNovel.lastReadParagraphId
    ? registry.require('paragraph', oldNovel.lastReadParagraphId)
    : undefined;
  const nextNovel: Novel = {
    ...oldNovel,
    id: newNovelId,
    activeContentRevisionId: mappedActiveRevision,
    rawText: '',
    normalizedText: '',
    rawTextHash: rawHash,
    normalizedTextHash: normalizedHash,
    lastReadChapterId,
    lastReadParagraphId,
  };
  accumulator.target('novels', nextNovel.id, nextNovel as unknown as Record<string, unknown>);
  return nextNovel;
}

export function canonicalBookHashes(novel: Novel): { normalizedHash: string; rawHash: string } {
  const normalizedSource = novel.normalizedText || undefined;
  return {
    normalizedHash: canonicalStoredHash(
      novel.normalizedTextHash,
      normalizedSource,
      `Novel ${novel.id} normalized hash`,
      'book',
      novel.id,
    ),
    // rawTextHash covers original file bytes, which cannot be re-created from decoded text for non-UTF-8 sources.
    rawHash: canonicalStoredHash(novel.rawTextHash, undefined, `Novel ${novel.id} raw hash`, 'book', novel.id),
  };
}

export function migrationIdentityKey(sourceFileName: string, normalizedHash: string): string {
  return JSON.stringify([sourceFileName, normalizedHash]);
}

export function canonicalPayloadHash(payload: unknown): string {
  return integrityHash(JSON.stringify(payload));
}

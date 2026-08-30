import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashSync, stableId } from '../domain/hash';
import { integrityHash, isIntegrityHash } from '../domain/id-hash-contract';
import { parsedChapterId, parsedNovelId, parsedParagraphId, paragraphPageId } from '../domain/parser/entity-identities';
import type {
  Bookmark,
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  Paragraph,
  ParagraphPage,
  ParsedNovel,
  ReaderHighlight,
  ReaderNote,
  ReadingPosition,
  UserCorrection,
  VoiceProfile,
} from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import type { SyncOutboxItem } from '../sync/types';
import {
  getBookmarks,
  getChapters,
  getNovel,
  getNovels,
  getParagraphs,
  getReadingPosition,
  getIdV2MigrationProgress,
  listSyncOutbox,
  openReaderDb,
  resetReaderDbForTests,
  saveImportedNovel,
  subscribeIdV2MigrationProgress,
} from '../storage/db';
import { contentDomainHeadId } from '../storage/content-revision-store';
import { READER_DB_VERSION } from '../storage/reader-database';
import {
  getIdV2MigrationStatus,
  rollbackIdV2Migration,
  runIdV2MigrationsInDatabase,
} from '../storage/id-v2-migration/engine';
import { resolveCanonicalNovelIdentityInDatabase } from '../storage/id-v2-migration/identity-lookup';
import { migrateBookScopedLocalStorageKeys } from '../storage/id-v2-migration/local-storage';
import { buildIdV2MigrationPlan } from '../storage/id-v2-migration/plan-builder';
import { loadIdV2BookSource } from '../storage/id-v2-migration/source-loader';
import {
  acquireIdV2MigrationLease,
  releaseIdV2MigrationLease,
  stageIdV2MigrationPlan,
} from '../storage/id-v2-migration/stage-store';

interface LegacyFixture {
  novel: Novel;
  chapter: Chapter;
  paragraphs: Paragraph[];
  page: ParagraphPage;
  pages: ParagraphPage[];
  normalizedHash: string;
  canonicalNovelId: string;
  canonicalChapterId: string;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function legacyFixture(
  seed: string,
  texts = ['First paragraph', 'Second paragraph'],
  paragraphsPerPage = 80,
): LegacyFixture {
  const sourceFileName = `${seed}.txt`;
  const body = texts.join('\n\n');
  const normalizedHash = integrityHash(body).slice('sha256:'.length);
  const novelId = stableId('novel', `${sourceFileName}:${normalizedHash}`, 14);
  const title = `${seed} title`;
  const chapterId = `ch_${hashSync(`${novelId}:1:${title}`)}`;
  let cursor = 0;
  const paragraphs = texts.map((text, offset): Paragraph => {
    const startOffsetInChapter = cursor;
    cursor += text.length + (offset < texts.length - 1 ? 2 : 0);
    return {
      id: `p_${hashSync(`${chapterId}:${offset}:${text}`)}`,
      novelId,
      chapterId,
      index: offset + 1,
      text,
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
      textHash: hashSync(text),
    };
  });
  const chapter: Chapter = {
    id: chapterId,
    novelId,
    index: 1,
    title,
    normalizedText: '',
    textHash: hashSync(body),
    rawStartOffset: 0,
    rawEndOffset: body.length,
    characterCount: body.length,
    paragraphCount: paragraphs.length,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const pages: ParagraphPage[] = [];
  for (let offset = 0; offset < paragraphs.length; offset += paragraphsPerPage) {
    const pageParagraphs = paragraphs.slice(offset, offset + paragraphsPerPage);
    const pageIndex = pages.length;
    pages.push({
      id: `page_${chapterId}_${pageIndex}`,
      novelId,
      chapterId,
      pageIndex,
      startParagraphIndex: pageParagraphs[0]?.index ?? 0,
      endParagraphIndex: pageParagraphs.at(-1)?.index ?? 0,
      paragraphs: pageParagraphs,
      textHash: hashSync(pageParagraphs.map((paragraph) => paragraph.textHash).join(':')),
    });
  }
  const novel: Novel = {
    id: novelId,
    activeContentRevisionId: `content_revision_${seed}`,
    title: seed,
    sourceFileName,
    sourceEncoding: 'utf-8',
    rawText: '',
    normalizedText: '',
    rawTextHash: normalizedHash,
    normalizedTextHash: normalizedHash,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: body.length,
    totalParagraphs: paragraphs.length,
    coverSeed: 1,
    lastReadChapterId: chapterId,
    lastReadParagraphId: paragraphs[0].id,
    lastReadOffset: 10,
    lastReadProgress: 0.25,
    favorite: false,
    analysisStatus: 'ready',
  };
  const canonicalNovelId = parsedNovelId(sourceFileName, `sha256:${normalizedHash}`);
  return {
    novel,
    chapter,
    paragraphs,
    page: pages[0],
    pages,
    normalizedHash,
    canonicalNovelId,
    canonicalChapterId: parsedChapterId(canonicalNovelId, 1, title),
  };
}

function deterministicAsciiTexts(totalBytes: number, paragraphCount: number): string[] {
  const separatorBytes = Math.max(0, paragraphCount - 1) * 2;
  const textBytes = totalBytes - separatorBytes;
  if (paragraphCount < 1 || textBytes < paragraphCount * 16) {
    throw new Error('Deterministic migration fixture is too small for its paragraph count');
  }
  const baseLength = Math.floor(textBytes / paragraphCount);
  const remainder = textBytes % paragraphCount;
  return Array.from({ length: paragraphCount }, (_, index) => {
    const length = baseLength + (index < remainder ? 1 : 0);
    const prefix = `${index.toString().padStart(4, '0')}:`;
    return `${prefix}${String.fromCharCode(97 + (index % 26)).repeat(length - prefix.length)}`;
  });
}

function canonicalParsedFixture(fixture: LegacyFixture): ParsedNovel {
  const body = fixture.paragraphs.map((paragraph) => paragraph.text).join('\n\n');
  const paragraphs = fixture.paragraphs.map((paragraph, index): Paragraph => ({
    ...paragraph,
    id: parsedParagraphId(fixture.canonicalNovelId, fixture.canonicalChapterId, index, paragraph.text),
    novelId: fixture.canonicalNovelId,
    chapterId: fixture.canonicalChapterId,
    textHash: integrityHash(paragraph.text),
  }));
  const chapter: Chapter = {
    ...fixture.chapter,
    id: fixture.canonicalChapterId,
    novelId: fixture.canonicalNovelId,
    normalizedText: body,
    textHash: integrityHash(body),
  };
  return {
    novel: {
      ...fixture.novel,
      id: fixture.canonicalNovelId,
      activeContentRevisionId: undefined,
      rawText: body,
      normalizedText: body,
      rawTextHash: `sha256:${fixture.normalizedHash}`,
      normalizedTextHash: `sha256:${fixture.normalizedHash}`,
      lastReadChapterId: fixture.canonicalChapterId,
      lastReadParagraphId: paragraphs[0]?.id,
      favorite: true,
    },
    chapters: [chapter],
    paragraphs,
  };
}

function revisionStorageId(revisionId: string, id: string): string {
  return JSON.stringify([revisionId, id]);
}

async function insertLegacyFixture(db: IDBDatabase, fixture: LegacyFixture, includeReferences = false): Promise<void> {
  const revisionId = fixture.novel.activeContentRevisionId!;
  const stores = [
    'novels',
    'book_content_revisions',
    'book_content_chapters',
    'book_content_paragraphs',
    'book_content_paragraph_pages',
    'book_content_paragraph_search',
    'book_content_domain_heads',
    'reading_positions',
    'bookmarks',
    'highlights',
    'notes',
    'characters',
    'character_relations',
    'segments',
    'corrections',
    'voice_profiles',
    'sync_tombstones',
    'sync_outbox',
  ];
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore('novels').put(fixture.novel);
  tx.objectStore('book_content_revisions').put({
    id: revisionId,
    novelId: fixture.novel.id,
    status: 'active',
    source: 'local_import',
    sourceHash: fixture.normalizedHash,
    normalizedHash: fixture.normalizedHash,
    baseNovelPresent: false,
    expected: { chapterCount: 1, pageCount: fixture.pages.length, paragraphCount: fixture.paragraphs.length },
    actual: {
      chapterCount: 1,
      pageCount: fixture.pages.length,
      paragraphCount: fixture.paragraphs.length,
      paragraphRefCount: fixture.paragraphs.length,
      searchRowCount: fixture.paragraphs.length,
    },
    createdAt: fixture.novel.createdAt,
    activatedAt: fixture.novel.createdAt,
  });
  tx.objectStore('book_content_chapters').put({
    ...fixture.chapter,
    storageId: revisionStorageId(revisionId, fixture.chapter.id),
    contentRevisionId: revisionId,
  });
  fixture.pages.forEach((page) => {
    tx.objectStore('book_content_paragraph_pages').put({
      ...page,
      storageId: revisionStorageId(revisionId, page.id),
      contentRevisionId: revisionId,
    });
    page.paragraphs.forEach((paragraph) => {
      tx.objectStore('book_content_paragraphs').put({
        ...paragraph,
        text: '',
        pageIndex: page.pageIndex,
        textStorageMode: 'page',
        storageId: revisionStorageId(revisionId, paragraph.id),
        contentRevisionId: revisionId,
      });
      const searchId = `search_${page.id}_${paragraph.index}`;
      tx.objectStore('book_content_paragraph_search').put({
        id: searchId,
        storageId: revisionStorageId(revisionId, searchId),
        contentRevisionId: revisionId,
        novelId: fixture.novel.id,
        chapterId: fixture.chapter.id,
        paragraphId: paragraph.id,
        pageId: page.id,
        pageIndex: page.pageIndex,
        paragraphIndex: paragraph.index,
        textLower: paragraph.text.toLowerCase(),
        paragraph,
      });
    });
  });
  tx.objectStore('book_content_domain_heads').put({
    id: contentDomainHeadId('chapter', fixture.chapter.id),
    entityType: 'chapter',
    domainId: fixture.chapter.id,
    novelId: fixture.novel.id,
    contentRevisionId: revisionId,
  });
  fixture.paragraphs.forEach((paragraph) =>
    tx.objectStore('book_content_domain_heads').put({
      id: contentDomainHeadId('paragraph', paragraph.id),
      entityType: 'paragraph',
      domainId: paragraph.id,
      novelId: fixture.novel.id,
      contentRevisionId: revisionId,
    }),
  );

  if (includeReferences) insertReferenceRows(tx, fixture);
  await transactionDone(tx);
}

function createLegacyContentStores(db: IDBDatabase): void {
  const novelStore = db.createObjectStore('novels', { keyPath: 'id' });
  novelStore.createIndex('updatedAt', 'updatedAt');
  novelStore.createIndex('title', 'title');
  const chapterStore = db.createObjectStore('chapters', { keyPath: 'id' });
  chapterStore.createIndex('novelId', 'novelId');
  const paragraphStore = db.createObjectStore('paragraphs', { keyPath: 'id' });
  paragraphStore.createIndex('novelId', 'novelId');
  paragraphStore.createIndex('chapterId', 'chapterId');
  paragraphStore.createIndex('chapterId_index', ['chapterId', 'index'], { unique: true });
  const pageStore = db.createObjectStore('paragraph_pages', { keyPath: 'id' });
  pageStore.createIndex('novelId', 'novelId');
  pageStore.createIndex('chapterId', 'chapterId');
  pageStore.createIndex('chapterId_pageIndex', ['chapterId', 'pageIndex'], { unique: true });
}

function createRevisionStores(db: IDBDatabase): void {
  const revisions = db.createObjectStore('book_content_revisions', { keyPath: 'id' });
  revisions.createIndex('novelId', 'novelId');
  revisions.createIndex('status', 'status');
  revisions.createIndex('novelId_status', ['novelId', 'status']);
  revisions.createIndex('sourceRevision', 'sourceRevision');
  const createScoped = (name: string) => db.createObjectStore(name, { keyPath: 'storageId' });
  const chapters = createScoped('book_content_chapters');
  chapters.createIndex('contentRevisionId', 'contentRevisionId');
  chapters.createIndex('novelId', 'novelId');
  chapters.createIndex('domainId', 'id');
  chapters.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
  chapters.createIndex('contentRevisionId_index', ['contentRevisionId', 'index'], { unique: true });
  const paragraphs = createScoped('book_content_paragraphs');
  paragraphs.createIndex('contentRevisionId', 'contentRevisionId');
  paragraphs.createIndex('novelId', 'novelId');
  paragraphs.createIndex('domainId', 'id');
  paragraphs.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
  paragraphs.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
  paragraphs.createIndex('contentRevisionId_chapterId_index', ['contentRevisionId', 'chapterId', 'index'], {
    unique: true,
  });
  const pages = createScoped('book_content_paragraph_pages');
  pages.createIndex('contentRevisionId', 'contentRevisionId');
  pages.createIndex('novelId', 'novelId');
  pages.createIndex('domainId', 'id');
  pages.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
  pages.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
  pages.createIndex('contentRevisionId_chapterId_pageIndex', ['contentRevisionId', 'chapterId', 'pageIndex'], {
    unique: true,
  });
  const search = createScoped('book_content_paragraph_search');
  search.createIndex('contentRevisionId', 'contentRevisionId');
  search.createIndex('novelId', 'novelId');
  search.createIndex('paragraphId', 'paragraphId');
  search.createIndex('contentRevisionId_paragraphId', ['contentRevisionId', 'paragraphId'], { unique: true });
  search.createIndex(
    'contentRevisionId_chapterId_paragraphIndex',
    ['contentRevisionId', 'chapterId', 'paragraphIndex'],
    { unique: true },
  );
  const heads = db.createObjectStore('book_content_domain_heads', { keyPath: 'id' });
  heads.createIndex('novelId', 'novelId');
  heads.createIndex('contentRevisionId', 'contentRevisionId');
  heads.createIndex('entityType', 'entityType');
}

async function createVersionedLegacyDatabase(version: 4 | 7 | 11 | 12, fixture: LegacyFixture): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('noveldesk-reader', version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (version === 4) {
        const novels = db.createObjectStore('novels', { keyPath: 'id' });
        novels.createIndex('updatedAt', 'updatedAt');
        novels.createIndex('title', 'title');
        novels.put({
          ...fixture.novel,
          activeContentRevisionId: undefined,
          totalChapters: 0,
          totalParagraphs: 0,
          totalCharacters: 0,
          lastReadChapterId: undefined,
          lastReadParagraphId: undefined,
        });
        return;
      }
      createLegacyContentStores(db);
      const novel = { ...fixture.novel, activeContentRevisionId: undefined };
      request.transaction!.objectStore('novels').put(novel);
      request.transaction!.objectStore('chapters').put(fixture.chapter);
      fixture.paragraphs.forEach((paragraph) => request.transaction!.objectStore('paragraphs').put(paragraph));
      fixture.pages.forEach((page) => request.transaction!.objectStore('paragraph_pages').put(page));
      if (version === 12) {
        createRevisionStores(db);
        const revisionId = fixture.novel.activeContentRevisionId!;
        request.transaction!.objectStore('novels').put(fixture.novel);
        request.transaction!.objectStore('book_content_revisions').put({
          id: revisionId,
          novelId: fixture.novel.id,
          status: 'active',
          source: 'local_import',
          sourceHash: fixture.normalizedHash,
          normalizedHash: fixture.normalizedHash,
          baseNovelPresent: false,
          expected: { chapterCount: 1, pageCount: fixture.pages.length, paragraphCount: fixture.paragraphs.length },
          actual: {
            chapterCount: 1,
            pageCount: fixture.pages.length,
            paragraphCount: fixture.paragraphs.length,
            paragraphRefCount: fixture.paragraphs.length,
            searchRowCount: fixture.paragraphs.length,
          },
          createdAt: fixture.novel.createdAt,
        });
        request.transaction!.objectStore('book_content_chapters').put({
          ...fixture.chapter,
          storageId: revisionStorageId(revisionId, fixture.chapter.id),
          contentRevisionId: revisionId,
        });
        fixture.pages.forEach((page) => {
          request.transaction!.objectStore('book_content_paragraph_pages').put({
            ...page,
            storageId: revisionStorageId(revisionId, page.id),
            contentRevisionId: revisionId,
          });
          page.paragraphs.forEach((paragraph) =>
            request.transaction!.objectStore('book_content_paragraphs').put({
              ...paragraph,
              text: '',
              pageIndex: page.pageIndex,
              storageId: revisionStorageId(revisionId, paragraph.id),
              contentRevisionId: revisionId,
            }),
          );
        });
      }
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function insertReferenceRows(tx: IDBTransaction, fixture: LegacyFixture): void {
  const [first] = fixture.paragraphs;
  const position: ReadingPosition = {
    id: `reading_position_${fixture.novel.id}`,
    novelId: fixture.novel.id,
    chapterId: fixture.chapter.id,
    paragraphId: first.id,
    paragraphIndex: 1,
    offsetInParagraph: 1,
    chapterProgress: 0.25,
    scrollTop: 10,
    deviceId: 'device_local',
    updatedAt: fixture.novel.updatedAt,
  };
  const bookmark: Bookmark = {
    id: stableId('bookmark', fixture.novel.id),
    novelId: fixture.novel.id,
    chapterId: fixture.chapter.id,
    paragraphId: first.id,
    label: 'anchor',
    progress: 0.25,
    scrollTop: 10,
    createdAt: fixture.novel.createdAt,
  };
  const highlight: ReaderHighlight = {
    id: stableId('highlight', fixture.novel.id),
    novelId: fixture.novel.id,
    chapterId: fixture.chapter.id,
    paragraphId: first.id,
    quote: first.text,
    color: 'yellow',
    progress: 0.25,
    createdAt: fixture.novel.createdAt,
    updatedAt: fixture.novel.updatedAt,
  };
  const note: ReaderNote = {
    id: stableId('note', fixture.novel.id),
    novelId: fixture.novel.id,
    chapterId: fixture.chapter.id,
    paragraphId: first.id,
    body: 'note',
    progress: 0.25,
    createdAt: fixture.novel.createdAt,
    updatedAt: fixture.novel.updatedAt,
  };
  const character: Character = {
    id: stableId('character', fixture.novel.id),
    novelId: fixture.novel.id,
    canonicalName: 'Alice',
    aliases: [],
    color: '#123456',
    confidence: 1,
    isUserConfirmed: true,
  };
  const relation: CharacterRelation = {
    id: stableId('relation', fixture.novel.id),
    novelId: fixture.novel.id,
    sourceCharacterId: character.id,
    targetCharacterId: character.id,
    relationLabel: 'self',
    termsUsedBySource: [],
    termsUsedByTarget: [],
    confidence: 1,
  };
  const voice: VoiceProfile = {
    id: stableId('voice_profile', fixture.novel.id),
    novelId: fixture.novel.id,
    characterId: character.id,
    role: 'character',
    providerId: 'system',
    providerVoiceId: 'default',
    label: 'Alice',
    speed: 1,
    isUserSelected: true,
  };
  const segment: LabeledSegment = {
    id: stableId('segment', fixture.novel.id),
    novelId: fixture.novel.id,
    chapterId: fixture.chapter.id,
    paragraphId: first.id,
    segmentIndex: 0,
    startOffset: 0,
    endOffset: first.text.length,
    segmentTextHash: hashSync(first.text),
    type: 'quoted_dialogue',
    speakerId: character.id,
    candidateSpeakers: [character.id],
    listenerIds: [character.id],
    emotion: 'neutral',
    confidence: 1,
    voiceProfileId: voice.id,
    isUserCorrected: true,
  };
  const correction: UserCorrection = {
    id: stableId('correction', fixture.novel.id),
    novelId: fixture.novel.id,
    chapterId: fixture.chapter.id,
    paragraphId: first.id,
    segmentId: segment.id,
    correctionType: 'speaker',
    beforeJson: JSON.stringify({ speakerId: character.id, segmentId: segment.id }),
    afterJson: JSON.stringify({ speakerId: character.id, voiceProfileId: voice.id }),
    applyScope: 'chapter',
    createdAt: fixture.novel.createdAt,
  };
  tx.objectStore('reading_positions').put(position);
  tx.objectStore('bookmarks').put(bookmark);
  tx.objectStore('highlights').put(highlight);
  tx.objectStore('notes').put(note);
  tx.objectStore('characters').put(character);
  tx.objectStore('character_relations').put(relation);
  tx.objectStore('voice_profiles').put(voice);
  tx.objectStore('segments').put(segment);
  tx.objectStore('corrections').put(correction);
  const deletedBookmarkId = stableId('bookmark', `${fixture.novel.id}:deleted`);
  tx.objectStore('sync_tombstones').put({
    id: `bookmark:${deletedBookmarkId}`,
    entityType: 'bookmark',
    entityId: deletedBookmarkId,
    novelId: fixture.novel.id,
    deletedAt: fixture.novel.updatedAt,
    createdAt: fixture.novel.updatedAt,
  });
  const eventId = stableId('sync_event', fixture.novel.id);
  const outbox: SyncOutboxItem = {
    id: stableId('sync_outbox', eventId),
    event: {
      id: eventId,
      type: 'bookmark_created',
      deviceId: 'device_local',
      novelId: fixture.novel.id,
      entityId: bookmark.id,
      payload: JSON.parse(JSON.stringify({ bookmark })),
      revision: {
        entityType: 'bookmark',
        entityId: bookmark.id,
        novelId: fixture.novel.id,
        localSequence: 1,
        updatedAt: fixture.novel.updatedAt,
        payloadHash: hashSync(JSON.stringify({ bookmark })),
      },
      createdAt: fixture.novel.createdAt,
    },
    status: 'sending',
    localSequence: 1,
    attempts: 0,
    leaseToken: 'stale-lease',
    leaseExpiresAt: '2026-07-01T00:00:01.000Z',
    createdAt: fixture.novel.createdAt,
    updatedAt: fixture.novel.updatedAt,
  };
  tx.objectStore('sync_outbox').put(outbox);
}

describe('IndexedDB v13 ID/hash migration through the current schema', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('atomically migrates revision content and every local reference group', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('complete');
    await insertLegacyFixture(db, fixture, true);

    const summary = await runIdV2MigrationsInDatabase(db, { batchSize: 3 });
    const novel = await getNovel(fixture.canonicalNovelId);
    const chapters = await getChapters(fixture.canonicalNovelId);
    const paragraphs = await getParagraphs(fixture.canonicalChapterId);
    const position = await getReadingPosition(fixture.canonicalNovelId);
    const bookmarks = await getBookmarks(fixture.canonicalNovelId);
    const outbox = await listSyncOutbox();

    expect(summary).toMatchObject({ status: 'completed', migratedBooks: 1, quarantinedBooks: 0 });
    expect(await getNovel(fixture.novel.id)).toBeUndefined();
    expect(novel).toMatchObject({
      id: fixture.canonicalNovelId,
      normalizedTextHash: `sha256:${fixture.normalizedHash}`,
      lastReadChapterId: fixture.canonicalChapterId,
    });
    expect(isIntegrityHash(novel!.rawTextHash)).toBe(true);
    expect(chapters.map((chapter) => chapter.id)).toEqual([fixture.canonicalChapterId]);
    expect(paragraphs.map((paragraph) => paragraph.id)).toEqual(
      fixture.paragraphs.map((paragraph, index) =>
        parsedParagraphId(fixture.canonicalNovelId, fixture.canonicalChapterId, index, paragraph.text),
      ),
    );
    expect(position).toMatchObject({ novelId: fixture.canonicalNovelId, chapterId: fixture.canonicalChapterId });
    expect(bookmarks).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', localSequence: 1, leaseToken: undefined });
    expect(outbox[0].event.revision?.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const artifactTx = db.transaction(
      ['characters', 'character_relations', 'segments', 'corrections', 'voice_profiles', 'sync_tombstones'],
      'readonly',
    );
    const [characters, relations, segments, corrections, voices, tombstones] = await Promise.all(
      ['characters', 'character_relations', 'segments', 'corrections', 'voice_profiles', 'sync_tombstones'].map(
        (store) => requestToPromise<Record<string, unknown>[]>(artifactTx.objectStore(store).getAll()),
      ),
    );
    await transactionDone(artifactTx);
    expect(characters).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      novelId: fixture.canonicalNovelId,
      sourceCharacterId: characters[0].id,
      targetCharacterId: characters[0].id,
    });
    expect(segments[0]).toMatchObject({
      novelId: fixture.canonicalNovelId,
      speakerId: characters[0].id,
      voiceProfileId: voices[0].id,
    });
    expect(segments[0].segmentTextHash).toMatch(/^sha256:/);
    expect(corrections[0].beforeJson).toContain(String(characters[0].id));
    expect(tombstones[0]).toMatchObject({ novelId: fixture.canonicalNovelId });
    const headsTx = db.transaction('book_content_domain_heads', 'readonly');
    const heads = await requestToPromise<Record<string, unknown>[]>(
      headsTx.objectStore('book_content_domain_heads').index('novelId').getAll(fixture.canonicalNovelId),
    );
    await transactionDone(headsTx);
    expect(heads).toHaveLength(1 + fixture.paragraphs.length);
    expect(new Set(heads.map((head) => head.contentRevisionId))).toEqual(new Set([novel!.activeContentRevisionId]));
  });

  it('preserves mixed v1 and already-canonical v2 reader anchors', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('mixed-anchors', ['First anchor', 'Second anchor']);
    const canonicalParagraphId = parsedParagraphId(
      fixture.canonicalNovelId,
      fixture.canonicalChapterId,
      0,
      fixture.paragraphs[0].text,
    );
    fixture.novel.lastReadParagraphId = canonicalParagraphId;
    await insertLegacyFixture(db, fixture);

    const write = db.transaction(['reading_positions', 'bookmarks'], 'readwrite');
    write.objectStore('reading_positions').put({
      id: `reading_position_${fixture.novel.id}`,
      novelId: fixture.novel.id,
      chapterId: fixture.canonicalChapterId,
      paragraphId: fixture.paragraphs[0].id,
      paragraphIndex: 1,
      offsetInParagraph: 1,
      chapterProgress: 0.25,
      scrollTop: 10,
      deviceId: 'device_local',
      updatedAt: fixture.novel.updatedAt,
    } satisfies ReadingPosition);
    write.objectStore('bookmarks').put({
      id: stableId('bookmark', fixture.novel.id),
      novelId: fixture.novel.id,
      chapterId: fixture.chapter.id,
      paragraphId: canonicalParagraphId,
      label: 'mixed anchor',
      progress: 0.25,
      scrollTop: 10,
      createdAt: fixture.novel.createdAt,
    } satisfies Bookmark);
    await transactionDone(write);

    expect(await runIdV2MigrationsInDatabase(db, { batchSize: 10 })).toMatchObject({ migratedBooks: 1 });
    expect(await getNovel(fixture.canonicalNovelId)).toMatchObject({ lastReadParagraphId: canonicalParagraphId });
    expect(await getReadingPosition(fixture.canonicalNovelId)).toMatchObject({
      chapterId: fixture.canonicalChapterId,
      paragraphId: canonicalParagraphId,
    });
    expect(await getBookmarks(fixture.canonicalNovelId)).toEqual([
      expect.objectContaining({ chapterId: fixture.canonicalChapterId, paragraphId: canonicalParagraphId }),
    ]);
  });

  it.each([4, 7, 11, 12] as const)(
    'upgrades a v%s database through metadata-only migration stores',
    async (version) => {
      const fixture = legacyFixture(`upgrade-v${version}`);
      await createVersionedLegacyDatabase(version, fixture);

      const db = await openReaderDb();
      expect(db.version).toBe(READER_DB_VERSION);
      expect(db.objectStoreNames.contains('id_migration_runs')).toBe(true);
      expect(db.objectStoreNames.contains('id_mappings')).toBe(true);
      expect(db.objectStoreNames.contains('id_migration_stage')).toBe(true);
      expect(db.objectStoreNames.contains('id_migration_quarantine')).toBe(true);
      expect(db.objectStoreNames.contains('native_analysis_staging')).toBe(true);
      expect(await getNovel(fixture.novel.id)).toBeUndefined();
      expect(await getNovel(fixture.canonicalNovelId)).toBeDefined();
      expect(await getChapters(fixture.canonicalNovelId)).toHaveLength(version === 4 ? 0 : 1);
    },
  );

  it('keeps startup reads consistent while publishing progress before openReaderDb resolves', async () => {
    const fixture = legacyFixture(
      'startup-progress',
      Array.from({ length: 12 }, (_, index) => `${index}: ${'startup text '.repeat(4)}`),
    );
    await createVersionedLegacyDatabase(12, fixture);
    let openResolved = false;
    let progressBeforeResolve = false;
    let timerFired = false;
    const unsubscribe = subscribeIdV2MigrationProgress(() => {
      const current = getIdV2MigrationProgress();
      if (current.oldNovelId === fixture.novel.id && current.status === 'staging' && !openResolved) {
        progressBeforeResolve = true;
      }
    });
    globalThis.setTimeout(() => {
      timerFired = true;
    }, 0);

    const db = await openReaderDb().then((opened) => {
      openResolved = true;
      return opened;
    });
    unsubscribe();
    expect(db.version).toBe(READER_DB_VERSION);
    expect(progressBeforeResolve).toBe(true);
    expect(timerFired).toBe(true);
    expect(await getNovel(fixture.novel.id)).toBeUndefined();
    expect(await getNovel(fixture.canonicalNovelId)).toBeDefined();
  });

  it('resumes from a persisted batch checkpoint after cancellation', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture(
      'resume',
      Array.from({ length: 12 }, (_, index) => `Paragraph ${index}`),
    );
    await insertLegacyFixture(db, fixture);
    const controller = new AbortController();
    const first = await runIdV2MigrationsInDatabase(db, {
      batchSize: 5,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.status === 'staging' && progress.completedRecords >= 10) controller.abort();
      },
    });
    const stagedRun = (await getIdV2MigrationStatus(db)).find((run) => run.oldNovelId === fixture.novel.id)!;
    expect(first.status).toBe('cancelled');
    expect(stagedRun.status).toBe('staging');
    expect(stagedRun.checkpoint).toBeGreaterThanOrEqual(10);

    const second = await runIdV2MigrationsInDatabase(db, { batchSize: 7 });
    expect(second.migratedBooks).toBe(1);
    expect(await getParagraphs(fixture.canonicalChapterId)).toHaveLength(12);
  });

  it('quarantines an unknown hash without touching the original book', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('unknown-hash');
    fixture.novel.normalizedTextHash = 'not-a-supported-hash';
    await insertLegacyFixture(db, fixture);

    const summary = await runIdV2MigrationsInDatabase(db);
    const run = (await getIdV2MigrationStatus(db)).find((item) => item.oldNovelId === fixture.novel.id);
    expect(summary.quarantinedBooks).toBe(1);
    expect(run).toMatchObject({ status: 'quarantined', errorCode: 'unknown_hash' });
    expect(await getNovel(fixture.novel.id)).toBeDefined();
    expect(await getNovel(fixture.canonicalNovelId)).toBeUndefined();
  });

  it('quarantines a verified source hash mismatch without partial writes', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('hash-mismatch');
    fixture.paragraphs[0].textHash = hashSync('different text');
    await insertLegacyFixture(db, fixture);

    const summary = await runIdV2MigrationsInDatabase(db);
    const run = (await getIdV2MigrationStatus(db)).find((item) => item.oldNovelId === fixture.novel.id);
    expect(summary.quarantinedBooks).toBe(1);
    expect(run).toMatchObject({ status: 'quarantined', errorCode: 'hash_mismatch' });
    expect(await getNovel(fixture.novel.id)).toBeDefined();
    expect(await getNovel(fixture.canonicalNovelId)).toBeUndefined();
  });

  it('aborts the whole cutover when any target key collides', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('atomic-collision');
    await insertLegacyFixture(db, fixture, true);
    const collision = { ...fixture.novel, id: fixture.canonicalNovelId, activeContentRevisionId: undefined };
    const write = db.transaction('novels', 'readwrite');
    write.objectStore('novels').put(collision);
    await transactionDone(write);

    const summary = await runIdV2MigrationsInDatabase(db);
    expect(summary.quarantinedBooks).toBe(1);
    expect(await getNovel(fixture.novel.id)).toBeDefined();
    expect(await getReadingPosition(fixture.novel.id)).toBeDefined();
    expect(await getChapters(fixture.canonicalNovelId)).toEqual([]);
    const revisionTx = db.transaction('book_content_revisions', 'readonly');
    const targetRevisions = await requestToPromise<Record<string, unknown>[]>(
      revisionTx.objectStore('book_content_revisions').index('novelId').getAll(fixture.canonicalNovelId),
    );
    await transactionDone(revisionTx);
    expect(targetRevisions).toEqual([]);
  });

  it('isolates the known FNV collision across books', async () => {
    expect(hashSync('costarring')).toBe(hashSync('liquid'));
    const db = await openReaderDb();
    const first = legacyFixture('collision-a', ['costarring']);
    const second = legacyFixture('collision-b', ['liquid']);
    const sharedOldParagraphId = `p_${hashSync('costarring')}`;
    for (const fixture of [first, second]) {
      fixture.paragraphs[0].id = sharedOldParagraphId;
      fixture.page.paragraphs = fixture.paragraphs;
      fixture.page.textHash = hashSync(fixture.paragraphs.map((paragraph) => paragraph.textHash).join(':'));
      fixture.novel.lastReadParagraphId = sharedOldParagraphId;
    }
    await insertLegacyFixture(db, first);
    await insertLegacyFixture(db, second);

    const summary = await runIdV2MigrationsInDatabase(db, { batchSize: 20 });
    const firstParagraphs = await getParagraphs(first.canonicalChapterId);
    const secondParagraphs = await getParagraphs(second.canonicalChapterId);
    expect(summary).toMatchObject({ migratedBooks: 2, quarantinedBooks: 0 });
    expect(firstParagraphs[0]).toMatchObject({ text: 'costarring', novelId: first.canonicalNovelId });
    expect(secondParagraphs[0]).toMatchObject({ text: 'liquid', novelId: second.canonicalNovelId });
    expect(firstParagraphs[0].id).not.toBe(secondParagraphs[0].id);
  });

  it('continues a ready staged run forward after restart', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('forward-ready');
    await insertLegacyFixture(db, fixture);
    const source = (await loadIdV2BookSource(db, fixture.novel.id))!;
    const plan = await buildIdV2MigrationPlan(source);
    const ready = await stageIdV2MigrationPlan(db, plan, {
      batchSize: 2,
      throwIfCancelled() {},
      onBatch() {},
    });
    expect(ready.status).toBe('ready');
    expect(await getNovel(fixture.novel.id)).toBeDefined();

    const summary = await runIdV2MigrationsInDatabase(db);
    expect(summary.migratedBooks).toBe(1);
    expect(await getNovel(fixture.canonicalNovelId)).toBeDefined();
  });

  it('honors active leases, takes over expired leases, and cleans orphaned stage rows', async () => {
    const db = await openReaderDb();
    const orphanWrite = db.transaction('id_migration_stage', 'readwrite');
    orphanWrite.objectStore('id_migration_stage').put({
      id: 'orphan-stage-row',
      runId: 'missing-run',
      kind: 'target',
      storeName: 'novels',
      recordKey: 'missing-novel',
      value: { id: 'missing-novel' },
      valueHash: integrityHash('{"id":"missing-novel"}'),
    });
    await transactionDone(orphanWrite);
    expect(await acquireIdV2MigrationLease(db, 'other-tab', new Date(), 30_000)).toBe(true);
    expect(await runIdV2MigrationsInDatabase(db)).toMatchObject({ status: 'locked', migratedBooks: 0 });
    await releaseIdV2MigrationLease(db, 'other-tab');
    expect(await runIdV2MigrationsInDatabase(db)).toMatchObject({ status: 'idle' });
    const read = db.transaction('id_migration_stage', 'readonly');
    expect(await requestToPromise(read.objectStore('id_migration_stage').count())).toBe(0);
    await transactionDone(read);

    const fixture = legacyFixture('expired-lease');
    await insertLegacyFixture(db, fixture);
    expect(await acquireIdV2MigrationLease(db, 'suspended-tab', new Date(0), 5_000)).toBe(true);
    expect(await runIdV2MigrationsInDatabase(db)).toMatchObject({ status: 'completed', migratedBooks: 1 });
    expect(await getNovel(fixture.canonicalNovelId)).toBeDefined();
  });

  it('keeps rollback material and refuses rollback after a canonical write', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('rollback');
    await insertLegacyFixture(db, fixture);
    await runIdV2MigrationsInDatabase(db);
    const run = (await getIdV2MigrationStatus(db)).find((item) => item.oldNovelId === fixture.novel.id)!;

    await rollbackIdV2Migration(db, run.id);
    expect(await getNovel(fixture.novel.id)).toBeDefined();
    expect(await getNovel(fixture.canonicalNovelId)).toBeUndefined();

    const secondFixture = legacyFixture('unsafe-rollback');
    await insertLegacyFixture(db, secondFixture);
    await runIdV2MigrationsInDatabase(db);
    const secondRun = (await getIdV2MigrationStatus(db)).find((item) => item.oldNovelId === secondFixture.novel.id)!;
    const changed = (await getNovel(secondFixture.canonicalNovelId))!;
    const write = db.transaction('novels', 'readwrite');
    write.objectStore('novels').put({ ...changed, favorite: true });
    await transactionDone(write);
    await expect(rollbackIdV2Migration(db, secondRun.id)).rejects.toThrow('post-cutover writes');
    expect(await getNovel(secondFixture.canonicalNovelId)).toMatchObject({ favorite: true });
  });

  it('reimports the same parsed file into the single canonical book', async () => {
    const db = await openReaderDb();
    const fixture = legacyFixture('same-file');
    await insertLegacyFixture(db, fixture);
    await runIdV2MigrationsInDatabase(db);

    const resolved = await resolveCanonicalNovelIdentityInDatabase(
      db,
      fixture.novel.sourceFileName,
      fixture.normalizedHash,
    );
    expect(resolved).toBe(fixture.canonicalNovelId);
    const migrated = (await getNovel(fixture.canonicalNovelId))!;
    const favoriteWrite = db.transaction('novels', 'readwrite');
    favoriteWrite.objectStore('novels').put({ ...migrated, favorite: true });
    await transactionDone(favoriteWrite);
    const parsed = canonicalParsedFixture(fixture);
    await saveImportedNovel({ ...parsed, novel: { ...parsed.novel, favorite: false } });
    expect(await getNovels()).toHaveLength(1);
    expect(await getNovel(fixture.canonicalNovelId)).toMatchObject({ favorite: true });
    expect(await getParagraphs(fixture.canonicalChapterId)).toHaveLength(fixture.paragraphs.length);
    expect(paragraphPageId(fixture.canonicalNovelId, fixture.canonicalChapterId, 0)).toMatch(/^page_[0-9a-f]{32}$/);
  });

  it('moves workflow and upload-resume localStorage keys without App coupling', () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => void values.delete(key),
      setItem: (key, value) => void values.set(key, value),
    };
    const oldId = 'novel_deadbeef';
    const newId = 'novel_0123456789abcdef0123456789abcdef';
    storage.setItem(`noveldesk.book_ai_workflow.${oldId}`, 'workflow-1');
    storage.setItem(
      `noveldesk.remoteUploadSession.file|${encodeURIComponent(oldId)}`,
      JSON.stringify({ uploadId: 'upload-1', clientBookId: oldId }),
    );

    expect(migrateBookScopedLocalStorageKeys(oldId, newId, storage)).toEqual({
      workflowMoved: true,
      uploadSessionsMoved: 1,
    });
    expect(storage.getItem(`noveldesk.book_ai_workflow.${newId}`)).toBe('workflow-1');
    expect(storage.getItem(`noveldesk.book_ai_workflow.${oldId}`)).toBeNull();
    expect(storage.getItem(`noveldesk.remoteUploadSession.file|${encodeURIComponent(newId)}`)).toContain(newId);
  });

  it('publishes monotonic batch progress and yields the event loop in the fast contract suite', async () => {
    const db = await openReaderDb();
    const texts = Array.from({ length: 24 }, (_, index) => `${index}: ${'reader text '.repeat(8)}`);
    const fixture = legacyFixture('bounded-progress', texts);
    await insertLegacyFixture(db, fixture);
    const progress: number[] = [];
    const unsubscribe = subscribeIdV2MigrationProgress(() => {
      const current = getIdV2MigrationProgress();
      if (current.oldNovelId === fixture.novel.id && current.status === 'staging') {
        progress.push(current.completedRecords);
      }
    });
    let timerFired = false;
    globalThis.setTimeout(() => {
      timerFired = true;
    }, 0);

    const summary = await runIdV2MigrationsInDatabase(db, { batchSize: 8 });
    unsubscribe();
    expect(summary.migratedBooks).toBe(1);
    expect(timerFired).toBe(true);
    expect(progress.length).toBeGreaterThan(5);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(getIdV2MigrationProgress()).toMatchObject({ status: 'completed', migratedBooks: 1 });
    expect(await getParagraphs(fixture.canonicalChapterId)).toHaveLength(texts.length);
  });

  const largeFixtureIt = process.env.RUN_ID_V2_MIGRATION_20MIB === '1' ? it : it.skip;
  largeFixtureIt(
    'migrates an exact 20MiB deterministic fixture within the product gate',
    async () => {
      const db = await openReaderDb();
      const fixtureBytes = 20 * 1024 * 1024;
      const texts = deterministicAsciiTexts(fixtureBytes, 320);
      const fixture = legacyFixture('20mib-single-chapter', texts, 80);
      expect(fixture.novel.totalCharacters).toBe(fixtureBytes);
      expect(fixture.pages).toHaveLength(4);
      await insertLegacyFixture(db, fixture);

      const baselineHeap = process.memoryUsage().heapUsed;
      let peakHeap = baselineHeap;
      const heartbeatTimes = [performance.now()];
      const progress: number[] = [];
      const sampleHeap = () => {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      };
      const heartbeat = globalThis.setInterval(() => {
        heartbeatTimes.push(performance.now());
        sampleHeap();
      }, 10);
      const unsubscribe = subscribeIdV2MigrationProgress(() => {
        const current = getIdV2MigrationProgress();
        if (current.oldNovelId === fixture.novel.id && current.status === 'staging') {
          progress.push(current.completedRecords);
        }
        sampleHeap();
      });

      const startedAt = performance.now();
      const summary = await runIdV2MigrationsInDatabase(db, { batchSize: 200 });
      const elapsedMs = performance.now() - startedAt;
      heartbeatTimes.push(performance.now());
      globalThis.clearInterval(heartbeat);
      unsubscribe();
      const heartbeatGaps = heartbeatTimes.slice(1).map((time, index) => time - heartbeatTimes[index]);

      expect(summary).toMatchObject({ status: 'completed', migratedBooks: 1, quarantinedBooks: 0 });
      expect(progress.length).toBeGreaterThan(10);
      expect(progress).toEqual([...progress].sort((left, right) => left - right));
      expect(heartbeatTimes.length).toBeGreaterThan(10);
      expect(Math.max(...heartbeatGaps)).toBeLessThanOrEqual(250);
      expect(elapsedMs).toBeLessThanOrEqual(30_000);
      expect(peakHeap - baselineHeap).toBeLessThanOrEqual(384 * 1024 * 1024);
      expect(await getParagraphs(fixture.canonicalChapterId)).toHaveLength(texts.length);
    },
    45_000,
  );
});

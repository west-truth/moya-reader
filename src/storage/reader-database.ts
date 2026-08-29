import type { Chapter, Novel, ParagraphPage } from '../domain/types';
import type { ReadingPosition } from '../sync/types';
import { upgradeContentRevisionStores } from './content-revision-migration';
import {
  cleanupStaleImportArtifacts,
  pageBackedParagraphRef,
  putParagraphSearchRowsForPage,
  storedChapter,
  storedNovel,
} from './content-revision-store';
import { runIdV2MigrationsInDatabase } from './id-v2-migration/engine';
import { resetIdV2MigrationProgressForTests } from './id-v2-migration/progress';
import { upgradeIdV2MigrationStores } from './id-v2-migration/schema';
import { upgradeNativeAnalysisWorkflowStores } from './native-analysis-workflow/schema';
import { upgradeLabelMutationStores } from './label-mutation-schema';
import { upgradeCharacterGraphV2Stores } from './character-graph-v2-schema';
import { READER_ANCHOR_QUARANTINE_STORE, upgradeReaderAnchorQuarantineStore } from './reader-anchor-quarantine';
import { BOOK_ASSET_STORES, upgradeBookAssetStores } from './book-asset-schema';
import { BACKUP_RESTORE_RUNS_STORE, upgradeBackupStores } from './backup-schema';
import { CHAPTER_STRUCTURE_STORES, upgradeChapterStructureStores } from './chapter-structure-schema';
import { LIBRARY_MANAGEMENT_STORES, upgradeLibraryManagementStores } from './library-management-schema';
import { READER_PERSONALIZATION_STORES, upgradeReaderPersonalizationStores } from './reader-personalization-schema';
import { SPEAKER_ATTRIBUTION_STORES, upgradeSpeakerAttributionStores } from './speaker-attribution-schema';
import {
  TEMPORAL_CHARACTER_MEMORY_STORES,
  upgradeTemporalCharacterMemoryStores,
} from './temporal-character-memory-schema';
import { SPEAKER_WORKFLOW_STORES, upgradeSpeakerWorkflowStores } from './speaker-workflow-schema';
import { VOICE_CASTING_STORES, upgradeVoiceCastingStores } from './voice-casting-schema';
import { DOCUMENT_LISTENING_STORES, upgradeDocumentListeningStores } from './document-listening-schema';
import { READER_PAGE_MAP_STORE, upgradeReaderPageMapStore } from './reader-page-map-schema';
import { BOOK_ENRICHMENT_STORES, upgradeBookEnrichmentStores } from './book-enrichment-schema';

export const READER_DB_NAME = 'noveldesk-reader';
export const READER_DB_VERSION = 38;

export type ReaderStoreName =
  | 'novels'
  | 'book_content_revisions'
  | 'book_content_chapters'
  | 'book_content_paragraphs'
  | 'book_content_paragraph_pages'
  | 'book_content_paragraph_search'
  | 'book_content_domain_heads'
  | 'chapters'
  | 'paragraphs'
  | 'paragraph_pages'
  | 'paragraph_search'
  | 'bookmarks'
  | 'highlights'
  | 'notes'
  | 'settings'
  | 'segments'
  | 'characters'
  | 'character_relations'
  | 'voice_profiles'
  | 'voice_product_states'
  | 'corrections'
  | 'devices'
  | 'reading_positions'
  | 'sync_outbox'
  | 'sync_tombstones'
  | 'sync_state'
  | 'id_migration_runs'
  | 'id_mappings'
  | 'id_migration_stage'
  | 'id_migration_quarantine'
  | 'native_analysis_workflows'
  | 'native_analysis_workflow_descriptors'
  | 'native_analysis_staging'
  | 'native_analysis_provenance'
  | 'label_mutation_receipts'
  | 'label_mutation_invalidations'
  | 'label_reanalysis_plans'
  | 'character_facts_v2'
  | 'character_mentions_v2'
  | 'character_address_terms_v2'
  | 'character_speech_traits_v2'
  | 'character_relation_facts_v2'
  | 'character_evidence_v2'
  | 'character_merge_candidates_v2'
  | 'character_id_redirects_v2'
  | 'character_identity_receipts_v2'
  | typeof BOOK_ASSET_STORES.assets
  | typeof BOOK_ASSET_STORES.blobs
  | typeof BACKUP_RESTORE_RUNS_STORE
  | (typeof CHAPTER_STRUCTURE_STORES)[keyof typeof CHAPTER_STRUCTURE_STORES]
  | (typeof LIBRARY_MANAGEMENT_STORES)[keyof typeof LIBRARY_MANAGEMENT_STORES]
  | (typeof READER_PERSONALIZATION_STORES)[keyof typeof READER_PERSONALIZATION_STORES]
  | (typeof SPEAKER_ATTRIBUTION_STORES)[keyof typeof SPEAKER_ATTRIBUTION_STORES]
  | (typeof TEMPORAL_CHARACTER_MEMORY_STORES)[keyof typeof TEMPORAL_CHARACTER_MEMORY_STORES]
  | (typeof SPEAKER_WORKFLOW_STORES)[keyof typeof SPEAKER_WORKFLOW_STORES]
  | (typeof VOICE_CASTING_STORES)[keyof typeof VOICE_CASTING_STORES]
  | (typeof DOCUMENT_LISTENING_STORES)[keyof typeof DOCUMENT_LISTENING_STORES]
  | typeof READER_ANCHOR_QUARANTINE_STORE
  | typeof READER_PAGE_MAP_STORE
  | (typeof BOOK_ENRICHMENT_STORES)[keyof typeof BOOK_ENRICHMENT_STORES];

const LOCAL_DEVICE_ID = 'device_local';
let dbPromise: Promise<IDBDatabase> | undefined;

function createStore(db: IDBDatabase, name: ReaderStoreName): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'id' });
}

function ensureIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
  options?: IDBIndexParameters,
): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options);
  }
}

function backfillReadingPositions(transaction: IDBTransaction): void {
  const novelStore = transaction.objectStore('novels');
  const positionStore = transaction.objectStore('reading_positions');
  const request = novelStore.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const novel = cursor.value as Novel;
    if (novel.lastReadChapterId) {
      const updatedAt = novel.updatedAt ?? new Date().toISOString();
      const position: ReadingPosition = {
        id: `reading_position_${novel.id}`,
        novelId: novel.id,
        chapterId: novel.lastReadChapterId,
        paragraphId: novel.lastReadParagraphId,
        paragraphIndex: 0,
        offsetInParagraph: 0,
        chapterProgress: novel.lastReadProgress ?? 0,
        scrollTop: novel.lastReadOffset ?? 0,
        deviceId: LOCAL_DEVICE_ID,
        updatedAt,
      };
      positionStore.put(position);
    }
    cursor.continue();
  };
}

function stripExistingTextPayloads(transaction: IDBTransaction): void {
  if (transaction.db.objectStoreNames.contains('novels')) {
    const novelStore = transaction.objectStore('novels');
    const novelRequest = novelStore.openCursor();
    novelRequest.onsuccess = () => {
      const cursor = novelRequest.result;
      if (!cursor) return;
      cursor.update(storedNovel(cursor.value as Novel));
      cursor.continue();
    };
  }

  if (transaction.db.objectStoreNames.contains('chapters')) {
    const chapterStore = transaction.objectStore('chapters');
    const chapterRequest = chapterStore.openCursor();
    chapterRequest.onsuccess = () => {
      const cursor = chapterRequest.result;
      if (!cursor) return;
      cursor.update(storedChapter(cursor.value as Chapter));
      cursor.continue();
    };
  }
}

function stripParagraphTextPayloads(transaction: IDBTransaction): void {
  if (
    !transaction.db.objectStoreNames.contains('paragraphs') ||
    !transaction.db.objectStoreNames.contains('paragraph_pages')
  ) {
    return;
  }

  const paragraphStore = transaction.objectStore('paragraphs');
  const pageStore = transaction.objectStore('paragraph_pages');
  const request = pageStore.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const page = cursor.value as ParagraphPage;
    page.paragraphs.forEach((paragraph) => paragraphStore.put(pageBackedParagraphRef(paragraph, page.pageIndex)));
    cursor.continue();
  };
}

function backfillParagraphSearchRows(transaction: IDBTransaction): void {
  if (
    !transaction.db.objectStoreNames.contains('paragraph_pages') ||
    !transaction.db.objectStoreNames.contains('paragraph_search')
  ) {
    return;
  }

  const pageStore = transaction.objectStore('paragraph_pages');
  const searchStore = transaction.objectStore('paragraph_search');
  const request = pageStore.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    putParagraphSearchRowsForPage(searchStore, cursor.value as ParagraphPage);
    cursor.continue();
  };
}

function upgrade(db: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  if (!db.objectStoreNames.contains('novels')) {
    const store = createStore(db, 'novels');
    store.createIndex('updatedAt', 'updatedAt');
    store.createIndex('title', 'title');
  }
  if (!db.objectStoreNames.contains('chapters')) {
    const store = createStore(db, 'chapters');
    store.createIndex('novelId', 'novelId');
  }
  if (!db.objectStoreNames.contains('paragraphs')) {
    const store = createStore(db, 'paragraphs');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('chapterId_index', ['chapterId', 'index'], { unique: true });
  } else {
    ensureIndex(transaction.objectStore('paragraphs'), 'chapterId_index', ['chapterId', 'index'], { unique: true });
  }
  if (!db.objectStoreNames.contains('paragraph_pages')) {
    const store = createStore(db, 'paragraph_pages');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('chapterId_pageIndex', ['chapterId', 'pageIndex'], { unique: true });
  }
  if (!db.objectStoreNames.contains('paragraph_search')) {
    const store = createStore(db, 'paragraph_search');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('paragraphId', 'paragraphId');
    store.createIndex('chapterId_paragraphIndex', ['chapterId', 'paragraphIndex'], { unique: true });
  } else {
    const store = transaction.objectStore('paragraph_search');
    ensureIndex(store, 'novelId', 'novelId');
    ensureIndex(store, 'chapterId', 'chapterId');
    ensureIndex(store, 'paragraphId', 'paragraphId');
    ensureIndex(store, 'chapterId_paragraphIndex', ['chapterId', 'paragraphIndex'], { unique: true });
  }
  if (!db.objectStoreNames.contains('bookmarks')) {
    const store = createStore(db, 'bookmarks');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
  }
  if (!db.objectStoreNames.contains('highlights')) {
    const store = createStore(db, 'highlights');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('paragraphId', 'paragraphId');
  }
  if (!db.objectStoreNames.contains('notes')) {
    const store = createStore(db, 'notes');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
  }
  if (!db.objectStoreNames.contains('settings')) createStore(db, 'settings');
  if (!db.objectStoreNames.contains('segments')) {
    const store = createStore(db, 'segments');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
  }
  if (!db.objectStoreNames.contains('characters')) {
    const store = createStore(db, 'characters');
    store.createIndex('novelId', 'novelId');
  }
  if (!db.objectStoreNames.contains('character_relations')) {
    const store = createStore(db, 'character_relations');
    store.createIndex('novelId', 'novelId');
    store.createIndex('sourceCharacterId', 'sourceCharacterId');
    store.createIndex('targetCharacterId', 'targetCharacterId');
  }
  if (!db.objectStoreNames.contains('voice_profiles')) {
    const store = createStore(db, 'voice_profiles');
    store.createIndex('novelId', 'novelId');
    store.createIndex('novelId_role', ['novelId', 'role']);
  } else {
    const store = transaction.objectStore('voice_profiles');
    ensureIndex(store, 'novelId', 'novelId');
    ensureIndex(store, 'novelId_role', ['novelId', 'role']);
  }
  if (!db.objectStoreNames.contains('voice_product_states')) {
    const store = createStore(db, 'voice_product_states');
    store.createIndex('novelId', 'novelId', { unique: true });
  }
  if (!db.objectStoreNames.contains('corrections')) {
    const store = createStore(db, 'corrections');
    store.createIndex('novelId', 'novelId');
    store.createIndex('chapterId', 'chapterId');
  }
  if (!db.objectStoreNames.contains('devices')) {
    const store = createStore(db, 'devices');
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains('reading_positions')) {
    const store = createStore(db, 'reading_positions');
    store.createIndex('novelId', 'novelId', { unique: true });
    store.createIndex('chapterId', 'chapterId');
    store.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains('sync_outbox')) {
    const store = createStore(db, 'sync_outbox');
    store.createIndex('status', 'status');
    store.createIndex('createdAt', 'createdAt');
  }
  if (!db.objectStoreNames.contains('sync_tombstones')) {
    const store = createStore(db, 'sync_tombstones');
    store.createIndex('entityType', 'entityType');
    store.createIndex('entityId', 'entityId');
    store.createIndex('novelId', 'novelId');
    store.createIndex('deletedAt', 'deletedAt');
  }
  if (!db.objectStoreNames.contains('sync_state')) createStore(db, 'sync_state');

  upgradeContentRevisionStores(db, transaction);
  upgradeIdV2MigrationStores(db);
  upgradeNativeAnalysisWorkflowStores(db);
  upgradeLabelMutationStores(db);
  upgradeCharacterGraphV2Stores(db);
  upgradeReaderAnchorQuarantineStore(db);
  upgradeBookAssetStores(db, transaction);
  upgradeBackupStores(db);
  upgradeChapterStructureStores(db);
  upgradeLibraryManagementStores(db, transaction);
  upgradeReaderPersonalizationStores(db);
  upgradeSpeakerAttributionStores(db);
  upgradeTemporalCharacterMemoryStores(db);
  upgradeSpeakerWorkflowStores(db);
  upgradeVoiceCastingStores(db);
  upgradeDocumentListeningStores(db, transaction);
  upgradeReaderPageMapStore(db);
  upgradeBookEnrichmentStores(db, transaction);
  if (oldVersion > 0 && oldVersion < 5 && db.objectStoreNames.contains('novels')) backfillReadingPositions(transaction);
  if (oldVersion > 0 && oldVersion < 7) stripExistingTextPayloads(transaction);
  if (oldVersion > 0 && oldVersion < 8) stripParagraphTextPayloads(transaction);
  if (oldVersion > 0 && oldVersion < 9) backfillParagraphSearchRows(transaction);
}

export function openReaderDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(READER_DB_NAME, READER_DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = (event) => upgrade(request.result, request.transaction!, event.oldVersion);
    request.onblocked = () => {
      blocked = true;
      if (dbPromise === opening) dbPromise = undefined;
      reject(new Error('IndexedDB upgrade blocked by another open reader window'));
    };
    request.onsuccess = async () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = undefined;
      };
      try {
        // Reads remain blocked until a pending book-level cutover finishes, while the progress store stays observable.
        await runIdV2MigrationsInDatabase(db);
        // Crash cleanup is deliberately age-gated and bounded so startup never
        // turns into a full-library maintenance pass.
        await cleanupStaleImportArtifacts(db).catch(() => undefined);
        resolve(db);
      } catch (error) {
        db.close();
        if (dbPromise === opening) dbPromise = undefined;
        reject(error);
      }
    };
    request.onerror = () => {
      if (dbPromise === opening) dbPromise = undefined;
      reject(request.error);
    };
  });
  dbPromise = opening;
  return opening;
}

export async function resetReaderDbForTests(): Promise<void> {
  resetIdV2MigrationProgressForTests();
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = undefined;
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(READER_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB reset blocked'));
  });
}

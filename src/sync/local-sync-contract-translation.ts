import { openReaderDb } from '../storage/reader-database';
import { getChapter, getNovel, getParagraph, getParagraphPage } from '../storage/reader-query-store';
import { SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from './contract';
import {
  syncEventSourceBookId,
  syncHashForContract,
  syncPageHashForContract,
  translateSyncEventIdentity,
  type ContentHashTranslationInput,
  type SegmentHashTranslationInput,
  type SyncEventIdentityTranslationAdapter,
  type SyncIdentityEntityType,
} from './event-contract-translation';
import type { ResolvedSyncContract, SyncEvent } from './types';

interface LocalIdMapping {
  runId: string;
  oldNovelId: string;
  newNovelId: string;
  entityType: string;
  oldId: string;
  newId: string;
}

interface LocalMigrationRun {
  id: string;
  status: string;
}

const localEntityTypes: Readonly<Record<SyncIdentityEntityType, string>> = {
  book: 'novel',
  content_revision: 'content_revision',
  chapter: 'chapter',
  paragraph: 'paragraph',
  page: 'page',
  reading_position: 'reading_position',
  listening_position: 'listening_position',
  bookmark: 'bookmark',
  highlight: 'highlight',
  note: 'note',
  document_annotation: 'document_annotation',
  character: 'character',
  character_relation: 'character_relation',
  voice_profile: 'voice_profile',
  labeled_segment: 'segment',
  user_correction: 'correction',
  shelf: 'shelf',
  shelf_membership: 'shelf_membership',
  sync_event: 'sync_event',
};

const preservedSentinels = new Set(['narrator', 'system', 'unknown']);

export class LocalSyncContractTranslationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalSyncContractTranslationError';
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Sync alias lookup transaction aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('Sync alias lookup transaction failed.'));
  });
}

async function loadBookMappings(bookId: string): Promise<LocalIdMapping[]> {
  const db = await openReaderDb();
  if (!db.objectStoreNames.contains('id_mappings') || !db.objectStoreNames.contains('id_migration_runs')) {
    throw new LocalSyncContractTranslationError(
      'legacy_alias_store_missing',
      'This device has no retained v1 identity aliases for legacy sync.',
    );
  }
  const lookupTx = db.transaction('id_mappings', 'readonly');
  const lookupDone = transactionDone(lookupTx);
  const store = lookupTx.objectStore('id_mappings');
  const byOldRequest = requestResult<LocalIdMapping | undefined>(
    store.index('oldLookup').get([bookId, 'novel', '', bookId]),
  );
  const byNewRequest = requestResult<LocalIdMapping[]>(
    store.index('newLookup').getAll(IDBKeyRange.only([bookId, 'novel', bookId])),
  );
  const [byOld, byNew] = await Promise.all([byOldRequest, byNewRequest]);
  await lookupDone;
  const bookMapping = byOld ?? byNew[0];
  if (!bookMapping) {
    throw new LocalSyncContractTranslationError(
      'legacy_book_alias_missing',
      `Book ${bookId} has no complete retained v1/v2 alias.`,
    );
  }
  const loadTx = db.transaction(['id_mappings', 'id_migration_runs'], 'readonly');
  const loadDone = transactionDone(loadTx);
  const runRequest = requestResult<LocalMigrationRun | undefined>(
    loadTx.objectStore('id_migration_runs').get(bookMapping.runId),
  );
  const mappingsRequest = requestResult<LocalIdMapping[]>(
    loadTx.objectStore('id_mappings').index('runId').getAll(bookMapping.runId),
  );
  const [run, mappings] = await Promise.all([runRequest, mappingsRequest]);
  await loadDone;
  if (run?.status !== 'completed') {
    throw new LocalSyncContractTranslationError(
      'legacy_book_alias_incomplete',
      `Book ${bookId} does not have an activated v1/v2 alias set.`,
    );
  }
  return mappings;
}

class LocalAliasContext {
  constructor(
    readonly targetContract: ResolvedSyncContract,
    private readonly mappings: LocalIdMapping[],
  ) {}

  private candidates(entityType: SyncIdentityEntityType, value: string): LocalIdMapping[] {
    const localType = localEntityTypes[entityType];
    return this.mappings.filter(
      (mapping) => mapping.entityType === localType && (mapping.oldId === value || mapping.newId === value),
    );
  }

  map(entityType: SyncIdentityEntityType, value: string): string {
    if (preservedSentinels.has(value)) return value;
    const targets = new Set(
      this.candidates(entityType, value).map((mapping) =>
        this.targetContract.contractVersion === 2 ? mapping.newId : mapping.oldId,
      ),
    );
    if (targets.size !== 1) {
      throw new LocalSyncContractTranslationError(
        targets.size === 0 ? 'legacy_child_alias_missing' : 'legacy_child_alias_ambiguous',
        `${entityType} ${value} cannot be translated with a complete retained alias.`,
      );
    }
    return targets.values().next().value as string;
  }

  canonical(entityType: SyncIdentityEntityType, value: string): string {
    if (preservedSentinels.has(value)) return value;
    const targets = new Set(this.candidates(entityType, value).map((mapping) => mapping.newId));
    if (targets.size !== 1) {
      throw new LocalSyncContractTranslationError(
        'legacy_child_alias_missing',
        `${entityType} ${value} has no unambiguous canonical alias.`,
      );
    }
    return targets.values().next().value as string;
  }
}

class LocalEventTranslationAdapter implements SyncEventIdentityTranslationAdapter {
  constructor(
    readonly targetContract: ResolvedSyncContract,
    private readonly context: LocalAliasContext | undefined,
  ) {}

  mapId(entityType: SyncIdentityEntityType, value: string): Promise<string> {
    if (!this.context) {
      throw new LocalSyncContractTranslationError(
        'legacy_book_alias_missing',
        `${entityType} ${value} cannot be translated without a book alias context.`,
      );
    }
    return Promise.resolve(this.context.map(entityType, value));
  }

  async mapEventId(sourceEvent: SyncEvent, translatedEvent: SyncEvent): Promise<string> {
    if (!this.context) {
      throw new LocalSyncContractTranslationError(
        'sync_upgrade_required',
        `Sync event ${sourceEvent.id} has no complete retained event alias.`,
      );
    }
    void translatedEvent;
    return this.context.map('sync_event', sourceEvent.id);
  }

  async mapSegmentTextHash(input: SegmentHashTranslationInput): Promise<string> {
    if (!this.context) {
      throw new LocalSyncContractTranslationError(
        'legacy_segment_alias_missing',
        'A segment hash cannot be translated without book aliases.',
      );
    }
    const paragraphId = String(input.source.paragraphId ?? input.translated.paragraphId ?? '');
    const canonicalParagraphId = this.context.canonical('paragraph', paragraphId);
    const paragraph = await getParagraph(canonicalParagraphId);
    const startOffset = Number(input.source.startOffset);
    const endOffset = Number(input.source.endOffset);
    if (
      !paragraph ||
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      endOffset > paragraph.text.length
    ) {
      throw new LocalSyncContractTranslationError(
        'legacy_segment_text_missing',
        `Segment paragraph ${canonicalParagraphId} is unavailable for hash translation.`,
      );
    }
    const text = paragraph.text.slice(startOffset, endOffset);
    return syncHashForContract(this.targetContract, text);
  }

  async mapContentHash(input: ContentHashTranslationInput): Promise<string> {
    if (!this.context || !input.entityType) {
      throw new LocalSyncContractTranslationError(
        'legacy_content_hash_unverifiable',
        `${input.field} cannot be translated without canonical content.`,
      );
    }
    const sourceId = String(input.source.id ?? input.translated.id ?? '');
    if (input.entityType === 'book') {
      const novel = await getNovel(this.context.canonical('book', sourceId));
      const text = input.field === 'rawTextHash' ? novel?.rawText : novel?.normalizedText;
      if (text !== undefined) return syncHashForContract(this.targetContract, text);
    }
    if (input.entityType === 'chapter' && input.field === 'textHash') {
      const chapter = await getChapter(this.context.canonical('chapter', sourceId));
      if (chapter) return syncHashForContract(this.targetContract, chapter.normalizedText);
    }
    if (input.entityType === 'paragraph' && input.field === 'textHash') {
      const paragraph = await getParagraph(this.context.canonical('paragraph', sourceId));
      if (paragraph) return syncHashForContract(this.targetContract, paragraph.text);
    }
    if (input.entityType === 'page' && input.field === 'textHash') {
      const sourceChapterId = String(input.source.chapterId ?? input.translated.chapterId ?? '');
      const pageIndex = Number(input.source.pageIndex ?? input.translated.pageIndex);
      const chapterId = this.context.canonical('chapter', sourceChapterId);
      const page = Number.isInteger(pageIndex) ? await getParagraphPage(chapterId, pageIndex) : undefined;
      if (page) {
        const paragraphHashes = page.paragraphs.map((paragraph) =>
          syncHashForContract(this.targetContract, paragraph.text),
        );
        return syncPageHashForContract(this.targetContract, paragraphHashes);
      }
    }
    throw new LocalSyncContractTranslationError(
      'legacy_content_hash_unverifiable',
      `${input.field} cannot be recomputed from canonical local content.`,
    );
  }
}

async function translateEvent(event: SyncEvent, targetContract: ResolvedSyncContract): Promise<SyncEvent> {
  const bookId = syncEventSourceBookId(event);
  const mappings = bookId ? await loadBookMappings(bookId) : undefined;
  const context = mappings ? new LocalAliasContext(targetContract, mappings) : undefined;
  return translateSyncEventIdentity(event, new LocalEventTranslationAdapter(targetContract, context));
}

export interface TranslatedLocalSyncBatch {
  events: SyncEvent[];
  originalEventIdByTranslatedId: Map<string, string>;
}

export async function translateLocalSyncEventsToV1(events: SyncEvent[]): Promise<TranslatedLocalSyncBatch> {
  const translated = await Promise.all(events.map((event) => translateEvent(event, SYNC_CONTRACT_V1)));
  return {
    events: translated,
    originalEventIdByTranslatedId: new Map(translated.map((event, index) => [event.id, events[index].id])),
  };
}

export async function translateLocalPulledEventsToV2(events: SyncEvent[]): Promise<SyncEvent[]> {
  return Promise.all(events.map((event) => translateEvent(event, SYNC_CONTRACT_V2)));
}

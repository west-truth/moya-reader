import type {
  Bookmark,
  Chapter,
  Character,
  DocumentAnnotation,
  DocumentTextOrderOverride,
  LabeledSegment,
  ListeningPosition,
  Novel,
  Paragraph,
  ReaderHighlight,
  ReaderNote,
  ReadingPosition,
  ReadingSessionEvent,
  Shelf,
  ShelfMembership,
  UserCorrection,
  VoiceProfile,
} from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import { persistentId128 } from '../domain/id-hash-contract';
import type { LibraryCatalogRepository } from '../repositories/library-catalog-repository';
import type { ReaderPersonalizationRepository } from '../repositories/reader-personalization-repository';
import type { ReaderRepository } from '../repositories/reader-repository';
import { bookProgressFromChapterProgress } from '../storage/content-revision-remote-state';
import { getAllByIndex, getAllRecords, requestToPromise, transactionDone } from '../storage/indexeddb-transaction';
import { READER_PERSONALIZATION_STORES } from '../storage/reader-personalization-schema';
import { openReaderDb } from '../storage/reader-database';
import { DOCUMENT_LISTENING_STORES } from '../storage/document-listening-schema';
import { getListeningPosition } from '../storage/listening-position-store';
import type { SyncTombstone } from '../storage/sync-event-store';
import type { SyncOutboxItem } from '../sync/types';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_VERSION,
  type CloudVaultApplyReport,
  type CloudVaultArtifactRepository,
  type CloudVaultBookIdentityV1,
  type CloudVaultBookV1,
  type CloudVaultChapterRefV1,
  type CloudVaultParagraphRefV1,
  type CloudVaultShelfMembershipV1,
  type CloudVaultSnapshotV1,
  type CloudVaultSyncScope,
  type CloudVaultTombstoneV1,
} from './contracts';

const AI_TTS_EVENT_TYPES = new Set([
  'voice_profiles_updated',
  'voice_casting_updated',
  'user_correction_created',
  'user_correction_deleted',
  'character_graph_updated',
  'chapter_segments_updated',
]);

const epoch = new Date(0).toISOString();

function maxTimestamp(values: readonly (string | undefined)[], fallback = epoch): string {
  return values.reduce<string>((latest, value) => (value && value > latest ? value : latest), fallback);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

async function mapInBatches<T, R>(
  values: readonly T[],
  mapper: (value: T) => Promise<R>,
  batchSize = 64,
): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    output.push(...(await Promise.all(values.slice(index, index + batchSize).map(mapper))));
  }
  return output;
}

function outboxTime(items: readonly SyncOutboxItem[], novelId: string, types: ReadonlySet<string>, fallback: string) {
  return maxTimestamp(
    items
      .filter((item) => item.event.novelId === novelId && types.has(item.event.type))
      .map((item) => item.event.createdAt),
    fallback,
  );
}

function paragraphRefs(
  paragraphs: readonly (Paragraph | undefined)[],
  chapters: readonly Chapter[],
): CloudVaultParagraphRefV1[] {
  const chapterIndex = new Map(chapters.map((chapter) => [chapter.id, chapter.index]));
  return paragraphs
    .flatMap((paragraph) => {
      if (!paragraph) return [];
      const index = chapterIndex.get(paragraph.chapterId);
      if (index === undefined) return [];
      return [
        {
          id: paragraph.id,
          chapterId: paragraph.chapterId,
          chapterIndex: index,
          paragraphIndex: paragraph.index,
          textHash: paragraph.textHash,
        } satisfies CloudVaultParagraphRefV1,
      ];
    })
    .sort((left, right) =>
      left.chapterIndex === right.chapterIndex
        ? left.paragraphIndex - right.paragraphIndex
        : left.chapterIndex - right.chapterIndex,
    );
}

function scopedTombstones(
  tombstones: readonly SyncTombstone[],
  novelHashById: ReadonlyMap<string, string>,
  outbox: readonly SyncOutboxItem[],
): CloudVaultTombstoneV1[] {
  const removedMembershipShelfByEntity = new Map<string, string>();
  for (const item of outbox) {
    if (item.event.type !== 'shelf_membership_removed' || !item.event.entityId) continue;
    const payload = item.event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const shelfId = payload.shelfId;
    if (typeof shelfId === 'string') removedMembershipShelfByEntity.set(item.event.entityId, shelfId);
  }
  return tombstones
    .filter((item) =>
      [
        'bookmark',
        'highlight',
        'note',
        'document_annotation',
        'document_text_order_override',
        'reading_position',
        'listening_position',
        'user_correction',
        'shelf',
        'shelf_membership',
      ].includes(item.entityType),
    )
    .flatMap<CloudVaultTombstoneV1>((item): CloudVaultTombstoneV1[] => {
      const bookHash = item.novelId ? novelHashById.get(item.novelId) : undefined;
      if (item.entityType === 'shelf_membership') {
        const shelfId = removedMembershipShelfByEntity.get(item.entityId);
        if (!bookHash || !shelfId) return [];
        const entityId = vaultShelfMembershipId(shelfId, bookHash);
        return [
          {
            id: `shelf_membership:${entityId}`,
            entityType: item.entityType,
            entityId,
            bookHash,
            shelfId,
            deletedAt: item.deletedAt,
          },
        ];
      }
      if (item.entityType === 'document_text_order_override') {
        if (!bookHash || !Number.isInteger(item.pageIndex) || item.pageIndex! < 0) return [];
        const entityId = vaultDocumentTextOrderOverrideId(bookHash, item.pageIndex!);
        return [
          {
            id: `document_text_order_override:${entityId}`,
            entityType: item.entityType,
            entityId,
            bookHash,
            pageIndex: item.pageIndex,
            deletedAt: item.deletedAt,
          },
        ];
      }
      return [
        {
          id: item.id,
          entityType: item.entityType,
          entityId: item.entityId,
          bookHash,
          deletedAt: item.deletedAt,
        },
      ];
    });
}

function vaultShelfMembershipId(shelfId: string, bookHash: string): string {
  return persistentId128('cloud_vault_shelf_membership', [shelfId, bookHash]);
}

function localShelfMembershipId(shelfId: string, bookId: string): string {
  return persistentId128('shelf_membership', [shelfId, bookId]);
}

function vaultDocumentTextOrderOverrideId(bookHash: string, pageIndex: number): string {
  return persistentId128('cloud_vault_document_text_order_override', [bookHash, String(pageIndex)]);
}

function localDocumentTextOrderOverrideId(bookId: string, pageIndex: number): string {
  return persistentId128('document_text_order_override', [bookId, String(pageIndex)]);
}

interface CapturedBookParts {
  novel: Novel;
  chapters: Chapter[];
  readingPosition?: ReadingPosition;
  listeningPosition?: ListeningPosition;
  bookmarks: Bookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
  documentAnnotations: DocumentAnnotation[];
  documentTextOrderOverrides: DocumentTextOrderOverride[];
  readingSessions: ReadingSessionEvent[];
  characters: Character[];
  characterRelations: CharacterRelation[];
  segments: LabeledSegment[];
  voiceProfiles: VoiceProfile[];
  corrections: UserCorrection[];
  paragraphRefs: CloudVaultParagraphRefV1[];
}

interface PreparedBookApply {
  novel: Novel;
  identity: CloudVaultBookIdentityV1;
  applyMetadata: boolean;
  chapters: Map<string, Chapter>;
  readingPosition?: ReadingPosition;
  listeningPosition?: ListeningPosition;
  bookmarks: Bookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
  documentAnnotations: DocumentAnnotation[];
  documentTextOrderOverrides: DocumentTextOrderOverride[];
  readingSessions: ReadingSessionEvent[];
  characters: Character[];
  relations: CharacterRelation[];
  segments: LabeledSegment[];
  voiceProfiles: VoiceProfile[];
  corrections: UserCorrection[];
  quarantined: number;
}

export class IndexedDbCloudVaultArtifactRepository implements CloudVaultArtifactRepository {
  constructor(
    private readonly reader: ReaderRepository,
    private readonly catalog?: LibraryCatalogRepository,
    private readonly personalization?: ReaderPersonalizationRepository,
  ) {}

  async capture(input: {
    readonly deviceId: string;
    readonly scope: CloudVaultSyncScope;
    readonly capturedAt?: string;
  }): Promise<CloudVaultSnapshotV1> {
    const generatedAt = input.capturedAt ?? new Date().toISOString();
    const novels = (await this.reader.listNovels()).filter((novel) => !novel.deletedAt);
    const outbox = await this.reader.listSyncOutbox();
    const tombstones = await getAllRecords<SyncTombstone>('sync_tombstones');
    const books: CloudVaultBookV1[] = [];

    for (const novel of novels) {
      const chapters = await this.reader.listChapters(novel.id);
      const readingPosition = await this.reader.getReadingPosition(novel.id);
      const listeningPosition = await getListeningPosition(novel.id);
      const [bookmarks, highlights, notes] = input.scope.annotations
        ? await Promise.all([
            this.reader.listBookmarks(novel.id),
            this.reader.listHighlights(novel.id),
            this.reader.listNotes(novel.id),
          ])
        : [[], [], []];
      const documentAnnotations = input.scope.annotations
        ? (
            await getAllByIndex<DocumentAnnotation>(DOCUMENT_LISTENING_STORES.documentAnnotations, 'bookId', novel.id)
          ).filter((item) => !item.deletedAt)
        : [];
      const documentTextOrderOverrides = input.scope.annotations
        ? await getAllByIndex<DocumentTextOrderOverride>(
            DOCUMENT_LISTENING_STORES.documentTextOrderOverrides,
            'bookId',
            novel.id,
          )
        : [];
      const readingSessions =
        input.scope.statistics && this.personalization
          ? await this.personalization.listReadingSessions({ bookId: novel.id })
          : [];
      const [characters, characterRelations, voiceProfiles, corrections] = input.scope.aiTtsArtifacts
        ? await Promise.all([
            this.reader.listCharacters(novel.id),
            this.reader.listCharacterRelations(novel.id),
            this.reader.listVoiceProfiles(novel.id),
            this.reader.listCorrections(novel.id),
          ])
        : [[], [], [], []];
      const segments = input.scope.aiTtsArtifacts
        ? (await Promise.all(chapters.map((chapter) => this.reader.listSegments(chapter.id)))).flat()
        : [];
      const referencedParagraphIds = unique(
        [
          readingPosition?.paragraphId,
          listeningPosition?.anchor.kind === 'reflowable_text' ? listeningPosition.anchor.paragraphId : undefined,
          ...bookmarks.map((item) => item.paragraphId),
          ...highlights.map((item) => item.paragraphId),
          ...notes.map((item) => item.paragraphId),
          ...segments.map((item) => item.paragraphId),
          ...corrections.map((item) => item.paragraphId),
        ].filter((value): value is string => Boolean(value)),
      );
      const paragraphs = await mapInBatches(referencedParagraphIds, (id) => this.reader.getParagraph(id));
      const parts: CapturedBookParts = {
        novel,
        chapters,
        readingPosition,
        listeningPosition,
        bookmarks,
        highlights,
        notes,
        documentAnnotations,
        documentTextOrderOverrides,
        readingSessions,
        characters,
        characterRelations,
        segments,
        voiceProfiles,
        corrections,
        paragraphRefs: paragraphRefs(paragraphs, chapters),
      };
      books.push(this.toBookSnapshot(parts, outbox));
    }

    const [shelves, localShelfMemberships] =
      input.scope.library && this.catalog
        ? await Promise.all([this.catalog.listShelves(), this.catalog.listShelfMemberships()])
        : [[], []];
    const settings = input.scope.readerSettings ? await this.reader.getSettings() : undefined;
    const settingsUpdatedAt = input.scope.readerSettings
      ? maxTimestamp(
          outbox.filter((item) => item.event.type === 'settings_updated').map((item) => item.event.createdAt),
          generatedAt,
        )
      : undefined;
    const novelHashById = new Map(novels.map((novel) => [novel.id, novel.normalizedTextHash]));
    const shelfMemberships: CloudVaultShelfMembershipV1[] = localShelfMemberships.flatMap((membership) => {
      const bookHash = novelHashById.get(membership.bookId);
      return bookHash
        ? [
            {
              id: vaultShelfMembershipId(membership.shelfId, bookHash),
              shelfId: membership.shelfId,
              bookHash,
              createdAt: membership.createdAt,
            },
          ]
        : [];
    });
    return {
      format: CLOUD_VAULT_FORMAT,
      version: CLOUD_VAULT_VERSION,
      generatedAt,
      deviceId: input.deviceId,
      scope: input.scope,
      books,
      shelves,
      shelfMemberships,
      tombstones: scopedTombstones(tombstones, novelHashById, outbox),
      settings,
      settingsUpdatedAt,
    };
  }

  async apply(snapshot: CloudVaultSnapshotV1): Promise<CloudVaultApplyReport> {
    const localNovels = (await this.reader.listNovels()).filter((novel) => !novel.deletedAt);
    const localByHash = new Map(localNovels.map((novel) => [novel.normalizedTextHash, novel]));
    const prepared: PreparedBookApply[] = [];
    const waitingBookTitles: string[] = [];
    let quarantinedRecords = 0;

    for (const book of snapshot.books) {
      const localNovel = localByHash.get(book.identity.normalizedTextHash);
      if (!localNovel) {
        waitingBookTitles.push(book.identity.title);
        continue;
      }
      const next = await this.prepareBookApply(book, localNovel, snapshot.scope);
      prepared.push(next);
      quarantinedRecords += next.quarantined;
    }

    const db = await openReaderDb();
    const stores = [
      'novels',
      'reading_positions',
      DOCUMENT_LISTENING_STORES.listeningPositions,
      DOCUMENT_LISTENING_STORES.documentAnnotations,
      DOCUMENT_LISTENING_STORES.documentTextOrderOverrides,
      'bookmarks',
      'highlights',
      'notes',
      'segments',
      'characters',
      'character_relations',
      'voice_profiles',
      'corrections',
      'sync_tombstones',
      'shelves',
      'shelf_memberships',
      READER_PERSONALIZATION_STORES.sessions,
      'settings',
    ] as const;
    const tx = db.transaction([...stores], 'readwrite');
    let appliedRecords = 0;

    for (const book of prepared) appliedRecords += await this.applyPreparedBook(tx, book);
    if (snapshot.scope.library) {
      appliedRecords += this.applyShelves(tx, snapshot.shelves, snapshot.shelfMemberships, localByHash);
    }
    appliedRecords += await this.applyTombstones(tx, snapshot.tombstones, localByHash, snapshot.scope);
    if (snapshot.scope.readerSettings && snapshot.settings) {
      tx.objectStore('settings').put(snapshot.settings);
      appliedRecords += 1;
    }
    await transactionDone(tx);

    return {
      matchedBooks: prepared.length,
      waitingForSourceBooks: waitingBookTitles.length,
      appliedRecords,
      quarantinedRecords,
      waitingBookTitles: waitingBookTitles.sort((left, right) => left.localeCompare(right)),
    };
  }

  private toBookSnapshot(parts: CapturedBookParts, outbox: readonly SyncOutboxItem[]): CloudVaultBookV1 {
    const { novel } = parts;
    const annotationsAt = maxTimestamp(
      [
        ...parts.bookmarks.map((item) => item.createdAt),
        ...parts.highlights.map((item) => item.updatedAt),
        ...parts.notes.map((item) => item.updatedAt),
        ...parts.documentAnnotations.map((item) => item.deletedAt ?? item.updatedAt),
        ...parts.documentTextOrderOverrides.map((item) => item.updatedAt),
      ],
      novel.createdAt,
    );
    const aiTtsAt = maxTimestamp(
      [
        ...parts.voiceProfiles.map((item) => item.updatedAt ?? item.createdAt),
        ...parts.corrections.map((item) => item.createdAt),
        outboxTime(outbox, novel.id, AI_TTS_EVENT_TYPES, novel.createdAt),
      ],
      novel.createdAt,
    );
    return {
      identity: {
        bookId: novel.id,
        normalizedTextHash: novel.normalizedTextHash,
        activeContentRevisionId: novel.activeContentRevisionId,
        format: novel.format ?? 'txt',
        title: novel.title,
        author: novel.author,
        seriesTitle: novel.seriesTitle,
        seriesIndex: novel.seriesIndex,
        tags: novel.tags,
        description: novel.description,
        language: novel.language,
        favorite: novel.favorite,
        metadataRevision: novel.metadataRevision ?? 0,
        updatedAt: novel.updatedAt,
      },
      revisions: {
        metadataAt: novel.updatedAt,
        readerAt: maxTimestamp(
          [parts.readingPosition?.updatedAt, parts.listeningPosition?.updatedAt],
          novel.lastReadAt ?? novel.createdAt,
        ),
        annotationsAt,
        statisticsAt: maxTimestamp(
          parts.readingSessions.map((item) => item.endedAt),
          novel.lastReadAt ?? novel.createdAt,
        ),
        aiTtsAt,
      },
      chapters: parts.chapters.map((chapter): CloudVaultChapterRefV1 => ({
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        textHash: chapter.textHash,
      })),
      paragraphs: parts.paragraphRefs,
      readingPosition: parts.readingPosition,
      listeningPosition: parts.listeningPosition,
      bookmarks: parts.bookmarks,
      highlights: parts.highlights,
      notes: parts.notes,
      documentAnnotations: parts.documentAnnotations,
      documentTextOrderOverrides: parts.documentTextOrderOverrides.map((override) => ({
        ...override,
        id: vaultDocumentTextOrderOverrideId(novel.normalizedTextHash, override.pageIndex),
      })),
      readingSessions: parts.readingSessions,
      characters: parts.characters,
      characterRelations: parts.characterRelations,
      segments: parts.segments,
      voiceProfiles: parts.voiceProfiles,
      corrections: parts.corrections,
    };
  }

  private async prepareBookApply(
    book: CloudVaultBookV1,
    novel: Novel,
    scope: CloudVaultSyncScope,
  ): Promise<PreparedBookApply> {
    const localChapters = await this.reader.listChapters(novel.id);
    const localChapterByKey = new Map(
      localChapters.map((chapter) => [`${chapter.index}:${chapter.textHash}`, chapter]),
    );
    const chapterByRemoteId = new Map<string, Chapter>();
    for (const remote of book.chapters) {
      const local = localChapterByKey.get(`${remote.index}:${remote.textHash}`);
      if (local) chapterByRemoteId.set(remote.id, local);
    }
    const refsByRemoteChapter = new Map<string, CloudVaultParagraphRefV1[]>();
    for (const ref of book.paragraphs) {
      const values = refsByRemoteChapter.get(ref.chapterId) ?? [];
      values.push(ref);
      refsByRemoteChapter.set(ref.chapterId, values);
    }
    const paragraphByRemoteId = new Map<string, Paragraph>();
    for (const [remoteChapterId, refs] of refsByRemoteChapter) {
      const localChapter = chapterByRemoteId.get(remoteChapterId);
      if (!localChapter) continue;
      const wanted = new Map(refs.map((ref) => [`${ref.paragraphIndex}:${ref.textHash}`, ref.id]));
      const signal = new AbortController().signal;
      for await (const page of this.reader.iterateParagraphPages({ chapterId: localChapter.id, signal })) {
        for (const paragraph of page.paragraphs) {
          const remoteId = wanted.get(`${paragraph.index}:${paragraph.textHash}`);
          if (remoteId) paragraphByRemoteId.set(remoteId, paragraph);
        }
      }
    }
    let quarantined = 0;
    const remapAnchor = <T extends { novelId: string; chapterId: string; paragraphId?: string }>(
      item: T,
    ): T | undefined => {
      const chapter = chapterByRemoteId.get(item.chapterId);
      if (!chapter) {
        quarantined += 1;
        return undefined;
      }
      const paragraph = item.paragraphId ? paragraphByRemoteId.get(item.paragraphId) : undefined;
      if (item.paragraphId && !paragraph) {
        quarantined += 1;
        return undefined;
      }
      return {
        ...item,
        novelId: novel.id,
        chapterId: chapter.id,
        paragraphId: paragraph?.id,
      };
    };
    const remapArray = <T extends { novelId: string; chapterId: string; paragraphId?: string }>(items: readonly T[]) =>
      items.flatMap((item) => {
        const mapped = remapAnchor(item);
        return mapped ? [mapped] : [];
      });
    const readingPosition = book.readingPosition ? remapAnchor(book.readingPosition) : undefined;
    const remoteListening = book.listeningPosition;
    let listeningPosition: ListeningPosition | undefined;
    if (remoteListening) {
      const chapter = chapterByRemoteId.get(remoteListening.chapterId);
      const remoteAnchor = remoteListening.anchor;
      if (!chapter) {
        quarantined += 1;
      } else if (remoteAnchor.kind === 'reflowable_text') {
        const paragraph = paragraphByRemoteId.get(remoteAnchor.paragraphId);
        if (!paragraph) {
          quarantined += 1;
        } else {
          const contentRevisionId = novel.activeContentRevisionId ?? remoteListening.contentRevisionId;
          listeningPosition = {
            ...remoteListening,
            id: `listening_position_${novel.id}`,
            bookId: novel.id,
            chapterId: chapter.id,
            contentRevisionId,
            anchor: {
              ...remoteAnchor,
              paragraphId: paragraph.id,
              reader: {
                ...remoteAnchor.reader,
                bookId: novel.id,
                contentRevisionId,
                sectionId: chapter.id,
                blockId: paragraph.id,
              },
            },
          };
        }
      } else {
        listeningPosition = {
          ...remoteListening,
          id: `listening_position_${novel.id}`,
          bookId: novel.id,
          chapterId: chapter.id,
          anchor: { ...remoteAnchor, bookId: novel.id },
        };
      }
    }
    const documentAnnotations = scope.annotations
      ? (book.documentAnnotations ?? []).flatMap((annotation) => {
          if (
            annotation.deletedAt ||
            annotation.pageIndex < 0 ||
            annotation.pageIndex >= novel.totalChapters ||
            annotation.anchor.pageIndex !== annotation.pageIndex
          ) {
            quarantined += 1;
            return [];
          }
          return [
            {
              ...annotation,
              bookId: novel.id,
              anchor: { ...annotation.anchor, bookId: novel.id },
            } satisfies DocumentAnnotation,
          ];
        })
      : [];
    const documentTextOrderOverrides = scope.annotations
      ? (book.documentTextOrderOverrides ?? []).flatMap((override) => {
          if (
            !Number.isInteger(override.pageIndex) ||
            override.pageIndex < 0 ||
            override.pageIndex >= novel.totalChapters ||
            !override.pageHash ||
            override.orderedBlockFingerprints.length > 10_000 ||
            override.excludedBlockFingerprints.length > 10_000 ||
            [...override.orderedBlockFingerprints, ...override.excludedBlockFingerprints].some(
              (fingerprint) => typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 256,
            )
          ) {
            quarantined += 1;
            return [];
          }
          return [
            {
              ...override,
              id: localDocumentTextOrderOverrideId(novel.id, override.pageIndex),
              bookId: novel.id,
            } satisfies DocumentTextOrderOverride,
          ];
        })
      : [];
    return {
      novel,
      identity: book.identity,
      applyMetadata: scope.library,
      chapters: chapterByRemoteId,
      readingPosition,
      listeningPosition,
      bookmarks: scope.annotations ? remapArray(book.bookmarks) : [],
      highlights: scope.annotations ? remapArray(book.highlights) : [],
      notes: scope.annotations ? remapArray(book.notes) : [],
      documentAnnotations,
      documentTextOrderOverrides,
      readingSessions: scope.statistics ? book.readingSessions.map((item) => ({ ...item, bookId: novel.id })) : [],
      characters: scope.aiTtsArtifacts ? book.characters.map((item) => ({ ...item, novelId: novel.id })) : [],
      relations: scope.aiTtsArtifacts ? book.characterRelations.map((item) => ({ ...item, novelId: novel.id })) : [],
      segments: scope.aiTtsArtifacts ? remapArray(book.segments) : [],
      voiceProfiles: scope.aiTtsArtifacts ? book.voiceProfiles.map((item) => ({ ...item, novelId: novel.id })) : [],
      corrections: scope.aiTtsArtifacts ? remapArray(book.corrections) : [],
      quarantined,
    };
  }

  private async applyPreparedBook(tx: IDBTransaction, prepared: PreparedBookApply): Promise<number> {
    let applied = 0;
    const novelStore = tx.objectStore('novels');
    const current = (await requestToPromise<Novel | undefined>(novelStore.get(prepared.novel.id))) ?? prepared.novel;
    const position = prepared.readingPosition;
    const listeningPosition = prepared.listeningPosition;
    let nextNovel =
      prepared.applyMetadata && prepared.identity.updatedAt >= current.updatedAt
        ? {
            ...current,
            title: prepared.identity.title,
            author: prepared.identity.author,
            seriesTitle: prepared.identity.seriesTitle,
            seriesIndex: prepared.identity.seriesIndex,
            tags: prepared.identity.tags ? [...prepared.identity.tags] : undefined,
            description: prepared.identity.description,
            language: prepared.identity.language,
            favorite: prepared.identity.favorite,
            metadataRevision: Math.max(current.metadataRevision ?? 0, prepared.identity.metadataRevision),
            updatedAt: prepared.identity.updatedAt,
          }
        : current;
    if (position) {
      const existing = await requestToPromise<ReadingPosition | undefined>(
        tx.objectStore('reading_positions').index('novelId').get(current.id),
      );
      if (!existing || position.updatedAt >= existing.updatedAt) {
        const chapter = [...prepared.chapters.values()].find((item) => item.id === position.chapterId);
        tx.objectStore('reading_positions').put({
          ...position,
          id: `reading_position_${current.id}`,
          novelId: current.id,
        });
        nextNovel = {
          ...nextNovel,
          lastReadChapterId: position.chapterId,
          lastReadParagraphId: position.paragraphId,
          lastReadOffset: position.scrollTop,
          lastReadProgress: bookProgressFromChapterProgress(current, chapter, position.chapterProgress),
          lastReadAt: position.updatedAt,
        };
        applied += 1;
      }
    }
    if (listeningPosition) {
      const store = tx.objectStore(DOCUMENT_LISTENING_STORES.listeningPositions);
      const existing = await requestToPromise<ListeningPosition | undefined>(store.get(listeningPosition.id));
      if (!existing || listeningPosition.updatedAt >= existing.updatedAt) {
        store.put(listeningPosition);
        applied += 1;
      }
    }
    const readingSeconds = prepared.readingSessions.reduce((sum, item) => sum + Math.max(0, item.activeSeconds), 0);
    if (readingSeconds > (nextNovel.readingSeconds ?? 0)) nextNovel = { ...nextNovel, readingSeconds };
    novelStore.put(nextNovel);

    for (const [storeName, records] of [
      ['bookmarks', prepared.bookmarks],
      ['highlights', prepared.highlights],
      ['notes', prepared.notes],
      [DOCUMENT_LISTENING_STORES.documentAnnotations, prepared.documentAnnotations],
      [DOCUMENT_LISTENING_STORES.documentTextOrderOverrides, prepared.documentTextOrderOverrides],
      ['characters', prepared.characters],
      ['character_relations', prepared.relations],
      ['segments', prepared.segments],
      ['voice_profiles', prepared.voiceProfiles],
      ['corrections', prepared.corrections],
      [READER_PERSONALIZATION_STORES.sessions, prepared.readingSessions],
    ] as const) {
      const store = tx.objectStore(storeName);
      for (const record of records) {
        store.put(record);
        applied += 1;
      }
    }
    return applied;
  }

  private applyShelves(
    tx: IDBTransaction,
    shelves: readonly Shelf[],
    memberships: readonly CloudVaultShelfMembershipV1[],
    localByHash: ReadonlyMap<string, Novel>,
  ): number {
    const shelfStore = tx.objectStore('shelves');
    const membershipStore = tx.objectStore('shelf_memberships');
    for (const shelf of shelves) shelfStore.put(shelf);
    let applied = shelves.length;
    for (const membership of memberships) {
      const localNovel = localByHash.get(membership.bookHash);
      if (!localNovel) continue;
      membershipStore.put({
        id: localShelfMembershipId(membership.shelfId, localNovel.id),
        shelfId: membership.shelfId,
        bookId: localNovel.id,
        createdAt: membership.createdAt,
      } satisfies ShelfMembership);
      applied += 1;
    }
    return applied;
  }

  private async applyTombstones(
    tx: IDBTransaction,
    tombstones: readonly CloudVaultTombstoneV1[],
    localByHash: ReadonlyMap<string, Novel>,
    scope: CloudVaultSyncScope,
  ): Promise<number> {
    const storeByType = {
      bookmark: 'bookmarks',
      highlight: 'highlights',
      note: 'notes',
      document_annotation: DOCUMENT_LISTENING_STORES.documentAnnotations,
      document_text_order_override: DOCUMENT_LISTENING_STORES.documentTextOrderOverrides,
      reading_position: 'reading_positions',
      listening_position: DOCUMENT_LISTENING_STORES.listeningPositions,
      user_correction: 'corrections',
      shelf: 'shelves',
      shelf_membership: 'shelf_memberships',
    } as const;
    const enabledTypes = new Set<CloudVaultTombstoneV1['entityType']>([
      'reading_position',
      'listening_position',
      ...(scope.annotations
        ? (['bookmark', 'highlight', 'note', 'document_annotation', 'document_text_order_override'] as const)
        : []),
      ...(scope.aiTtsArtifacts ? (['user_correction'] as const) : []),
      ...(scope.library ? (['shelf', 'shelf_membership'] as const) : []),
    ]);
    let applied = 0;
    for (const tombstone of tombstones) {
      if (!enabledTypes.has(tombstone.entityType)) continue;
      const localNovel = tombstone.bookHash ? localByHash.get(tombstone.bookHash) : undefined;
      if (tombstone.bookHash && !localNovel) continue;
      const entityId =
        tombstone.entityType === 'reading_position' && localNovel
          ? `reading_position_${localNovel.id}`
          : tombstone.entityType === 'listening_position' && localNovel
            ? `listening_position_${localNovel.id}`
            : tombstone.entityType === 'document_text_order_override' && localNovel && tombstone.pageIndex !== undefined
              ? localDocumentTextOrderOverrideId(localNovel.id, tombstone.pageIndex)
              : tombstone.entityType === 'shelf_membership' && tombstone.shelfId && localNovel
                ? localShelfMembershipId(tombstone.shelfId, localNovel.id)
                : tombstone.entityId;
      const entityStore = tx.objectStore(storeByType[tombstone.entityType]);
      const existing = await requestToPromise<Record<string, unknown> | undefined>(entityStore.get(entityId));
      const timestampKey =
        tombstone.entityType === 'bookmark' ||
        tombstone.entityType === 'user_correction' ||
        tombstone.entityType === 'shelf_membership'
          ? 'createdAt'
          : 'updatedAt';
      const existingUpdatedAt = existing?.[timestampKey];
      if (typeof existingUpdatedAt === 'string' && existingUpdatedAt > tombstone.deletedAt) continue;
      entityStore.delete(entityId);
      tx.objectStore('sync_tombstones').put({
        id: `${tombstone.entityType}:${entityId}`,
        entityType: tombstone.entityType,
        entityId,
        novelId: localNovel?.id,
        pageIndex: tombstone.pageIndex,
        deletedAt: tombstone.deletedAt,
        createdAt: tombstone.deletedAt,
      } satisfies SyncTombstone);
      applied += 1;
    }
    return applied;
  }
}

import { describe, expect, it } from 'vitest';
import { hashSync } from '../domain/hash';
import { integrityHash, persistentId128 } from '../domain/id-hash-contract';
import { syncPayloadIntegrityHash } from '../domain/identity/sync-identities';
import { resolveSyncContract, SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from '../sync/contract';
import { validateV2SyncEvent } from '../sync/event-contract-validation';
import {
  syncHashForContract,
  syncPageHashForContract,
  translateSyncEventIdentity,
  type ContentHashTranslationInput,
  type SegmentHashTranslationInput,
  type SyncEventIdentityTranslationAdapter,
  type SyncIdentityEntityType,
} from '../sync/event-contract-translation';
import type { ResolvedSyncContract, SyncEvent } from '../sync/types';
import { translateLocalPulledEventsToV2, translateLocalSyncEventsToV1 } from '../sync/local-sync-contract-translation';

const sourceIds: Readonly<Record<SyncIdentityEntityType, string>> = {
  book: 'book_old',
  content_revision: 'revision_old',
  chapter: 'chapter_old',
  paragraph: 'paragraph_old',
  page: 'page_old',
  reading_position: 'position_old',
  listening_position: 'listening_position_old',
  bookmark: 'bookmark_old',
  highlight: 'highlight_old',
  note: 'note_old',
  document_annotation: 'document_annotation_old',
  character: 'character_old',
  character_relation: 'relation_old',
  voice_profile: 'voice_old',
  labeled_segment: 'segment_old',
  user_correction: 'correction_old',
  shelf: 'shelf_old',
  shelf_membership: 'membership_old',
  sync_event: 'event_old',
};

const canonicalIds = Object.fromEntries(
  Object.entries(sourceIds).map(([entityType, sourceId]) => [
    entityType,
    persistentId128(entityType === 'book' ? 'novel' : entityType, [sourceId]),
  ]),
) as Record<SyncIdentityEntityType, string>;

class MatrixAdapter implements SyncEventIdentityTranslationAdapter {
  constructor(
    readonly targetContract: ResolvedSyncContract,
    private readonly allowCanonicalLookup = false,
  ) {}

  mapId(entityType: SyncIdentityEntityType, value: string): Promise<string> {
    if (['narrator', 'system', 'unknown'].includes(value)) return Promise.resolve(value);
    const source = sourceIds[entityType];
    const canonical = canonicalIds[entityType];
    if (value !== source && value !== canonical) throw new Error(`missing ${entityType} alias for ${value}`);
    return Promise.resolve(this.targetContract.contractVersion === 2 ? canonical : source);
  }

  mapEventId(sourceEvent: SyncEvent): Promise<string> {
    return this.mapId('sync_event', sourceEvent.id);
  }

  mapSegmentTextHash(_input: SegmentHashTranslationInput): Promise<string> {
    return Promise.resolve(syncHashForContract(this.targetContract, 'Hello'));
  }

  mapContentHash(input: ContentHashTranslationInput): Promise<string> {
    if (!this.allowCanonicalLookup) throw new Error(`${input.field} has no canonical content`);
    return Promise.resolve(syncHashForContract(this.targetContract, 'Canonical text'));
  }
}

describe('versioned sync contract', () => {
  it('treats wholly missing fields as v1 and rejects partial or inconsistent tuples', () => {
    expect(resolveSyncContract({})).toEqual(SYNC_CONTRACT_V1);
    expect(() => resolveSyncContract({ contractVersion: 2 })).toThrow(/must identify the same sync contract/);
    expect(() =>
      resolveSyncContract({ contractVersion: 2, idContract: 'v1-legacy', hashContract: 'v1-legacy' }),
    ).toThrow(/must identify the same sync contract/);
  });

  it('recomputes paragraph, page, and segment hashes in both directions', async () => {
    const paragraph = { id: sourceIds.paragraph, text: 'Alpha', textHash: hashSync('Alpha') };
    const pageHash = syncPageHashForContract(SYNC_CONTRACT_V1, [paragraph.textHash]);
    const payload = {
      book: { id: sourceIds.book },
      paragraphPages: [
        {
          id: sourceIds.page,
          novelId: sourceIds.book,
          chapterId: sourceIds.chapter,
          pageIndex: 0,
          paragraphs: [paragraph],
          textHash: pageHash,
        },
      ],
    };
    const source: SyncEvent = {
      id: sourceIds.sync_event,
      type: 'book_updated',
      deviceId: 'device_a',
      novelId: sourceIds.book,
      entityId: sourceIds.book,
      payload,
      revision: {
        entityType: 'book',
        entityId: sourceIds.book,
        novelId: sourceIds.book,
        localSequence: 1,
        updatedAt: '2026-07-05T00:00:00.000Z',
        payloadHash: hashSync(JSON.stringify(payload)),
      },
      createdAt: '2026-07-05T00:00:00.000Z',
    };
    const current = await translateSyncEventIdentity(source, new MatrixAdapter(SYNC_CONTRACT_V2));
    const currentPage = (
      current.payload as { paragraphPages: Array<{ paragraphs: Array<{ textHash: string }>; textHash: string }> }
    ).paragraphPages[0];
    expect(currentPage.paragraphs[0].textHash).toBe(integrityHash('Alpha'));
    expect(currentPage.textHash).toBe(syncPageHashForContract(SYNC_CONTRACT_V2, [integrityHash('Alpha')]));
    expect(current.revision?.payloadHash).toBe(syncPayloadIntegrityHash(current.payload));
    validateV2SyncEvent(current);

    const roundTrip = await translateSyncEventIdentity(current, new MatrixAdapter(SYNC_CONTRACT_V1));
    const legacyPage = (
      roundTrip.payload as { paragraphPages: Array<{ paragraphs: Array<{ textHash: string }>; textHash: string }> }
    ).paragraphPages[0];
    expect(legacyPage.paragraphs[0].textHash).toBe(hashSync('Alpha'));
    expect(legacyPage.textHash).toBe(pageHash);

    const segmentPayload = {
      chapterId: sourceIds.chapter,
      segments: [
        {
          id: sourceIds.labeled_segment,
          novelId: sourceIds.book,
          chapterId: sourceIds.chapter,
          paragraphId: sourceIds.paragraph,
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 5,
          segmentTextHash: hashSync('Hello'),
          type: 'narration',
          speakerId: sourceIds.character,
          candidateSpeakers: [sourceIds.character],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 1,
        },
      ],
    };
    const segmentEvent: SyncEvent = {
      id: sourceIds.sync_event,
      type: 'chapter_segments_updated',
      deviceId: 'device_a',
      novelId: sourceIds.book,
      entityId: 'chapter_segments_old',
      payload: segmentPayload,
      revision: {
        entityType: 'chapter_segments',
        entityId: 'chapter_segments_old',
        novelId: sourceIds.book,
        localSequence: 2,
        updatedAt: '2026-07-05T00:00:00.000Z',
        payloadHash: hashSync(JSON.stringify(segmentPayload)),
      },
      createdAt: '2026-07-05T00:00:00.000Z',
    };
    const currentSegment = await translateSyncEventIdentity(segmentEvent, new MatrixAdapter(SYNC_CONTRACT_V2));
    expect(
      (currentSegment.payload as { segments: Array<{ segmentTextHash: string }> }).segments[0].segmentTextHash,
    ).toBe(integrityHash('Hello'));
    validateV2SyncEvent(currentSegment);
  });

  it('refuses to carry a textHash without text or a canonical-content lookup', async () => {
    const payload = {
      paragraph: { id: sourceIds.paragraph, textHash: hashSync('Canonical text') },
    };
    const source: SyncEvent = {
      id: sourceIds.sync_event,
      type: 'book_updated',
      deviceId: 'device_a',
      novelId: sourceIds.book,
      entityId: sourceIds.book,
      payload,
      createdAt: '2026-07-05T00:00:00.000Z',
    };

    await expect(translateSyncEventIdentity(source, new MatrixAdapter(SYNC_CONTRACT_V2))).rejects.toThrow(
      /has no canonical content/,
    );
    const translated = await translateSyncEventIdentity(source, new MatrixAdapter(SYNC_CONTRACT_V2, true));
    expect((translated.payload as { paragraph: { textHash: string } }).paragraph.textHash).toBe(
      integrityHash('Canonical text'),
    );
  });

  it('rekeys PDF reading-order overrides when a book identity changes', async () => {
    const payload = {
      orderOverride: {
        id: 'document_order_old',
        bookId: sourceIds.book,
        pageIndex: 7,
        pageHash: 'page-hash',
        sourceRevisionId: 'revision-hash',
        orderedBlockFingerprints: ['block-b', 'block-a'],
        excludedBlockFingerprints: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    const source: SyncEvent = {
      id: sourceIds.sync_event,
      type: 'document_text_order_override_updated',
      deviceId: 'device_a',
      novelId: sourceIds.book,
      entityId: 'document_order_old',
      payload,
      revision: {
        entityType: 'document_text_order_override',
        entityId: 'document_order_old',
        novelId: sourceIds.book,
        localSequence: 1,
        updatedAt: '2026-08-01T00:00:00.000Z',
        payloadHash: hashSync(JSON.stringify(payload)),
      },
      createdAt: '2026-08-01T00:00:00.000Z',
    };

    const translated = await translateSyncEventIdentity(source, new MatrixAdapter(SYNC_CONTRACT_V2));
    const expectedId = persistentId128('document_text_order_override', [canonicalIds.book, '7']);
    expect(translated.entityId).toBe(expectedId);
    expect(translated.revision?.entityId).toBe(expectedId);
    expect((translated.payload as { orderOverride: { id: string; bookId: string } }).orderOverride).toMatchObject({
      id: expectedId,
      bookId: canonicalIds.book,
    });
    validateV2SyncEvent(translated);
  });

  it('requires a retained sync_event alias instead of synthesizing a transport event ID', async () => {
    const legacySettings: SyncEvent = {
      id: 'event_old',
      type: 'settings_updated',
      deviceId: 'device_a',
      entityId: 'reader-settings',
      payload: { settings: { id: 'reader-settings', theme: 'sepia' } },
      createdAt: '2026-07-05T00:00:00.000Z',
    };
    const currentSettings: SyncEvent = {
      ...legacySettings,
      ...SYNC_CONTRACT_V2,
      id: canonicalIds.sync_event,
    };

    await expect(translateLocalPulledEventsToV2([legacySettings])).rejects.toMatchObject({
      code: 'sync_upgrade_required',
    });
    await expect(translateLocalSyncEventsToV1([currentSettings])).rejects.toMatchObject({
      code: 'sync_upgrade_required',
    });
  });
});

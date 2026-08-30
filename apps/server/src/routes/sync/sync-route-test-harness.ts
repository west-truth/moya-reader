import Fastify from 'fastify';
import { expect, vi } from 'vitest';
import pg from 'pg';
import { ServerConfig } from '../../config.js';
import { registerSyncRoutes } from '../sync.js';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import { integrityHash } from '@noveldesk/text-core/hash';
import { aggregateSyncEntityId, syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';

export const V2_SYNC_CONTRACT = SYNC_CONTRACT_V2;

export function v2PushEnvelope(events: SyncEvent[]) {
  return { ...SYNC_CONTRACT_V2, events };
}

export function v2PullUrl(since: number): string {
  return `/api/sync?since=${since}&contractVersion=2&idContract=v2-sha256-128&hashContract=v2-sha256-tagged`;
}

export function v2PullEvent(event: SyncEvent, sequence: number) {
  return {
    ...SYNC_CONTRACT_V2,
    sequence,
    id: event.id,
    device_id: event.deviceId,
    type: event.type,
    book_id: event.novelId ?? null,
    entity_id: event.entityId ?? null,
    payload: event.payload,
    revision: event.revision ?? null,
    created_at: event.createdAt,
  };
}

export function canonicalV2Event(source: SyncEvent): SyncEvent {
  const payload = source.payload as Record<string, unknown>;
  const entityId =
    source.type === 'voice_profiles_updated' && source.novelId
      ? aggregateSyncEntityId({ entityType: 'voice_profiles', novelId: source.novelId })
      : source.type === 'voice_casting_updated' && source.novelId
        ? aggregateSyncEntityId({ entityType: 'voice_casting', novelId: source.novelId })
        : source.type === 'character_graph_updated' && source.novelId
          ? aggregateSyncEntityId({ entityType: 'character_graph', novelId: source.novelId })
          : source.type === 'chapter_segments_updated' && source.novelId && typeof payload.chapterId === 'string'
            ? aggregateSyncEntityId({
                entityType: 'chapter_segments',
                novelId: source.novelId,
                chapterId: payload.chapterId,
              })
            : source.entityId;
  return {
    ...source,
    ...SYNC_CONTRACT_V2,
    id: syncEventId({
      userId: 'user_test',
      deviceId: source.deviceId,
      type: source.type,
      novelId: source.novelId,
      entityId,
      seed: `fixture:${source.id}`,
    }),
    entityId,
    revision: source.revision
      ? {
          ...source.revision,
          entityId: entityId ?? source.revision.entityId,
          payloadHash: syncPayloadIntegrityHash(source.payload),
        }
      : undefined,
  };
}

export function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

export function readingPositionEvent(id: string, updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id,
    type: 'reading_position_updated',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'reading_position_book_1',
    payload: {
      position: {
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        paragraphIndex: 12,
        offsetInParagraph: 3,
        chapterProgress: 0.42,
        scrollTop: 240,
        updatedAt,
      },
    },
    revision: {
      entityType: 'reading_position',
      entityId: 'reading_position_book_1',
      novelId: 'book_1',
      localSequence: 2,
      updatedAt,
      payloadHash: `hash-${id}`,
    },
    createdAt: updatedAt,
  });
}

export function bookmarkCreatedEvent(id: string, updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id,
    type: 'bookmark_created',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'bookmark_1',
    payload: {
      bookmark: {
        id: 'bookmark_1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        label: 'bookmark label',
        progress: 0.5,
        scrollTop: 300,
        createdAt: updatedAt,
      },
    },
    createdAt: updatedAt,
  });
}

export function highlightCreatedEvent(id: string, updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id,
    type: 'highlight_created',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'highlight_1',
    payload: {
      highlight: {
        id: 'highlight_1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        quote: 'highlight quote',
        color: 'yellow',
        progress: 0.6,
        createdAt: updatedAt,
        updatedAt,
      },
    },
    createdAt: updatedAt,
  });
}

export function noteUpdatedEvent(id: string, updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id,
    type: 'note_updated',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'note_1',
    payload: {
      note: {
        id: 'note_1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        quote: 'note quote',
        body: 'note body',
        progress: 0.7,
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt,
      },
    },
    createdAt: updatedAt,
  });
}

export function voiceProfilesUpdatedEvent(updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id: 'event_voice_profiles_update',
    type: 'voice_profiles_updated',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'voice_profiles_book_1',
    payload: {
      voiceProfiles: [
        {
          id: 'voice_narrator',
          novelId: 'book_1',
          role: 'narrator',
          providerId: 'elevenlabs',
          providerVoiceId: 'voice_remote_1',
          providerModel: 'eleven_multilingual_v2',
          label: 'Narrator',
          language: 'ko',
          tone: 'calm',
          speed: 1.05,
          pitch: 0.9,
          emotionPolicy: 'segment',
          providerOptions: { stability: 0.4 },
          isUserSelected: true,
          createdAt: updatedAt,
          updatedAt,
        },
      ],
    },
    revision: {
      entityType: 'voice_profiles',
      entityId: 'voice_profiles_book_1',
      novelId: 'book_1',
      localSequence: 3,
      updatedAt,
      payloadHash: 'hash-voice-profiles',
    },
    createdAt: updatedAt,
  });
}

export function voiceCastingUpdatedEvent(updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id: 'event_voice_casting_update',
    type: 'voice_casting_updated',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'voice_casting_book_1',
    payload: {
      version: 'voice-casting-v1',
      contentRevisionId: 'content_revision_1',
      storageRevision: 3,
      userArtifacts: {
        voiceProfileIds: ['voice_narrator'],
        pools: [],
        overrides: [],
        traitEvidence: [],
      },
    },
    revision: {
      entityType: 'voice_casting',
      entityId: 'voice_casting_book_1',
      novelId: 'book_1',
      localSequence: 4,
      updatedAt,
      payloadHash: 'hash-voice-casting',
    },
    createdAt: updatedAt,
  });
}

export function userCorrectionCreatedEvent(updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id: 'event_user_correction_create',
    type: 'user_correction_created',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'correction_1',
    payload: {
      correction: {
        id: 'correction_1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        segmentId: 'segment_1',
        correctionType: 'emotion',
        beforeJson: JSON.stringify({ emotion: 'neutral' }),
        afterJson: JSON.stringify({ emotion: 'tense' }),
        applyScope: 'future_pattern',
        createdAt: updatedAt,
      },
    },
    revision: {
      entityType: 'user_correction',
      entityId: 'correction_1',
      novelId: 'book_1',
      localSequence: 4,
      updatedAt,
      payloadHash: 'hash-user-correction',
    },
    createdAt: updatedAt,
  });
}

export function userCorrectionDeletedEvent(updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id: 'event_user_correction_delete',
    type: 'user_correction_deleted',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'correction_1',
    payload: {
      id: 'correction_1',
      deletedAt: updatedAt,
    },
    revision: {
      entityType: 'user_correction',
      entityId: 'correction_1',
      novelId: 'book_1',
      localSequence: 5,
      deletedAt: updatedAt,
      payloadHash: 'hash-user-correction-delete',
    },
    createdAt: updatedAt,
  });
}

export function characterGraphUpdatedEvent(updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id: 'event_character_graph_update',
    type: 'character_graph_updated',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'character_graph_book_1',
    payload: {
      mode: 'replace',
      characters: [
        {
          id: 'char_1',
          novelId: 'book_1',
          canonicalName: 'Alex',
          aliases: ['Al'],
          color: '#3b82f6',
          description: 'Generated character.',
          confidence: 0.9,
          isUserConfirmed: false,
        },
      ],
      relations: [],
    },
    revision: {
      entityType: 'character_graph',
      entityId: 'character_graph_book_1',
      novelId: 'book_1',
      localSequence: 5,
      updatedAt,
      payloadHash: 'hash-character-graph',
    },
    createdAt: updatedAt,
  });
}

export function chapterSegmentsUpdatedEvent(updatedAt: string): SyncEvent {
  return canonicalV2Event({
    id: 'event_chapter_segments_update',
    type: 'chapter_segments_updated',
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId: 'chapter_segments_chapter_1',
    payload: {
      chapterId: 'chapter_1',
      segments: [
        {
          id: 'segment_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 5,
          segmentTextHash: integrityHash('Hello'),
          type: 'narration',
          speakerId: 'char_1',
          candidateSpeakers: ['char_1'],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.8,
          isUserCorrected: false,
        },
      ],
    },
    revision: {
      entityType: 'chapter_segments',
      entityId: 'chapter_segments_chapter_1',
      novelId: 'book_1',
      localSequence: 6,
      updatedAt,
      payloadHash: 'hash-chapter-segments',
    },
    createdAt: updatedAt,
  });
}

export function deletedEvent(
  type: 'bookmark_deleted' | 'highlight_deleted' | 'note_deleted',
  entityId: string,
  updatedAt: string,
): SyncEvent {
  return canonicalV2Event({
    id: `event_${type}_${entityId}`,
    type,
    deviceId: 'device_a',
    novelId: 'book_1',
    entityId,
    payload: { id: entityId, deletedAt: updatedAt },
    createdAt: updatedAt,
  });
}

export async function appWithSync(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  await registerSyncRoutes(app, pool, testConfig());
  return app;
}

export function successfulInsertClient(onMaterialize: (sql: string, params?: unknown[]) => void) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (
        sql === 'begin' ||
        sql === 'commit' ||
        sql === 'rollback' ||
        sql.startsWith('savepoint ') ||
        sql.startsWith('rollback to savepoint ') ||
        sql.startsWith('release savepoint ')
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
      if (sql.includes('join book_content_revisions')) return { rowCount: 1, rows: [{ should_accept: true }] };
      if (sql.includes('from library_books') && sql.includes('for share')) {
        return { rowCount: 1, rows: [{ exists: true }] };
      }
      if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
      if (sql.includes('document_section_id is not null')) {
        return { rowCount: 1, rows: [{ has_section: false }] };
      }
      if (sql.includes('select exists(select 1 from paragraph_search'))
        return { rowCount: 1, rows: [{ exists: true }] };
      if (sql.includes('from paragraph_search'))
        return { rowCount: 1, rows: [{ paragraph_id: 'paragraph_1', text: 'Hello' }] };
      if (sql.includes('should_accept')) return { rowCount: 1, rows: [{ should_accept: true }] };
      if (sql.includes('insert into sync_events')) return { rowCount: 1, rows: [{ id: params?.[0] }] };
      onMaterialize(sql, params);
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
}

export function syncRoundTripPool() {
  const eventRows: Array<{
    sequence: number;
    id: string;
    device_id: string;
    type: SyncEvent['type'];
    book_id?: string;
    entity_id?: string;
    payload: unknown;
    revision?: unknown;
    created_at: string;
    id_contract: 'v2-sha256-128';
    hash_contract: 'v2-sha256-tagged';
    source_contract_version: number;
    source_event_id?: string;
  }> = [];
  const updatedAtByEntity = new Map<string, string>();

  const shouldAccept = (key: string, updatedAt: string) => {
    const current = updatedAtByEntity.get(key);
    return !current || current <= updatedAt;
  };
  const tableFromQuery = (sql: string) => {
    if (sql.includes('from bookmarks') || sql.includes('into bookmarks') || sql.includes('update bookmarks'))
      return 'bookmarks';
    if (sql.includes('from highlights') || sql.includes('into highlights') || sql.includes('update highlights'))
      return 'highlights';
    if (sql.includes('from notes') || sql.includes('into notes') || sql.includes('update notes')) return 'notes';
    return undefined;
  };

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };

      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };

      if (sql.includes('where user_id = $1 and sequence > $2')) {
        expect(params?.[0]).toBe('user_test');
        const since = Number(params?.[1] ?? 0);
        return { rows: eventRows.filter((row) => row.sequence > since).slice(0, 500) };
      }

      if (sql.includes('join book_content_revisions')) {
        return { rowCount: 1, rows: [{ should_accept: true }] };
      }
      if (sql.includes('from library_books') && sql.includes('for share')) {
        return { rowCount: 1, rows: [{ exists: true }] };
      }
      if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
      if (sql.includes('document_section_id is not null')) {
        return { rowCount: 1, rows: [{ has_section: false }] };
      }
      if (sql.includes('select exists(select 1 from paragraph_search'))
        return { rowCount: 1, rows: [{ exists: true }] };

      if (sql.includes('from reading_positions') && sql.includes('should_accept')) {
        const [bookId, userId, updatedAt] = params ?? [];
        return {
          rowCount: 1,
          rows: [{ should_accept: shouldAccept(`reading_positions:${userId}:${bookId}`, String(updatedAt)) }],
        };
      }

      if (sql.includes('should_accept')) {
        const table = tableFromQuery(sql);
        const [id, userId, updatedAt] = params ?? [];
        return {
          rowCount: 1,
          rows: [{ should_accept: table ? shouldAccept(`${table}:${userId}:${id}`, String(updatedAt)) : true }],
        };
      }

      if (sql.includes('insert into sync_events')) {
        const [id, _userId, deviceId, type, bookId, entityId, payload, revision, createdAt] = params ?? [];
        if (eventRows.some((row) => row.id === id)) return { rowCount: 0, rows: [] };
        eventRows.push({
          sequence: eventRows.length + 1,
          id: String(id),
          device_id: String(deviceId),
          type: type as SyncEvent['type'],
          book_id: typeof bookId === 'string' ? bookId : undefined,
          entity_id: typeof entityId === 'string' ? entityId : undefined,
          payload: JSON.parse(String(payload)),
          revision: typeof revision === 'string' ? JSON.parse(revision) : undefined,
          created_at: String(createdAt),
          id_contract: 'v2-sha256-128',
          hash_contract: 'v2-sha256-tagged',
          source_contract_version: 2,
        });
        return { rowCount: 1, rows: [{ id }] };
      }

      if (sql.includes('insert into reading_positions')) {
        const [bookId, userId, , , , , , , , updatedAt] = params ?? [];
        updatedAtByEntity.set(`reading_positions:${userId}:${bookId}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('insert into fixed_document_section_read_states')) return { rowCount: 0, rows: [] };

      if (sql.includes('insert into bookmarks')) {
        const [id, , userId, , , , , , updatedAt] = params ?? [];
        updatedAtByEntity.set(`bookmarks:${userId}:${id}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('update bookmarks')) {
        const [id, userId, updatedAt] = params ?? [];
        updatedAtByEntity.set(`bookmarks:${userId}:${id}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('insert into highlights')) {
        const [id, , userId, , , , , , , updatedAt] = params ?? [];
        updatedAtByEntity.set(`highlights:${userId}:${id}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('update highlights')) {
        const [id, userId, updatedAt] = params ?? [];
        updatedAtByEntity.set(`highlights:${userId}:${id}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('insert into notes')) {
        const [id, , userId, , , , , , , updatedAt] = params ?? [];
        updatedAtByEntity.set(`notes:${userId}:${id}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('update notes')) {
        const [id, userId, updatedAt] = params ?? [];
        updatedAtByEntity.set(`notes:${userId}:${id}`, String(updatedAt));
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`unexpected query: ${sql}`);
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as pg.Pool;

  return { pool, client, eventRows };
}

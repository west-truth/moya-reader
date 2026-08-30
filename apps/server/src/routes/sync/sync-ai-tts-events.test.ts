import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import {
  appWithSync,
  canonicalV2Event,
  chapterSegmentsUpdatedEvent,
  characterGraphUpdatedEvent,
  successfulInsertClient,
  userCorrectionCreatedEvent,
  userCorrectionDeletedEvent,
  voiceProfilesUpdatedEvent,
  voiceCastingUpdatedEvent,
  V2_SYNC_CONTRACT,
  v2PushEnvelope,
} from './sync-route-test-harness.js';

describe('sync AI and TTS event routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('materializes user-authored AI/TTS sync events', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const events = [
      voiceProfilesUpdatedEvent('2026-07-05T00:09:00.000Z'),
      userCorrectionCreatedEvent('2026-07-05T00:10:00.000Z'),
      userCorrectionDeletedEvent('2026-07-05T00:11:00.000Z'),
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(events),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 3,
      acceptedIds: events.map((event) => event.id),
    });
    expect(materialized).toHaveLength(5);
    expect(materialized[0]).toMatchObject({
      sql: expect.stringContaining('delete from voice_profiles'),
      params: ['book_1'],
    });
    expect(materialized[1]).toMatchObject({
      sql: expect.stringContaining('insert into voice_profiles'),
      params: [
        'voice_narrator',
        'book_1',
        null,
        'narrator',
        'elevenlabs',
        'voice_remote_1',
        'eleven_multilingual_v2',
        'Narrator',
        'ko',
        'calm',
        1.05,
        0.9,
        'segment',
        JSON.stringify({ stability: 0.4 }),
        true,
        '2026-07-05T00:09:00.000Z',
        '2026-07-05T00:09:00.000Z',
      ],
    });
    expect(materialized[2]).toMatchObject({
      sql: expect.stringContaining('insert into user_corrections'),
      params: [
        'correction_1',
        'book_1',
        'chapter_1',
        'paragraph_1',
        'segment_1',
        'emotion',
        JSON.stringify({ emotion: 'neutral' }),
        JSON.stringify({ emotion: 'tense' }),
        'future_pattern',
        null,
        null,
        'null',
        'legacy',
        null,
        '2026-07-05T00:10:00.000Z',
      ],
    });
    expect(materialized[3]).toMatchObject({
      sql: expect.stringContaining('update labeled_segments'),
      params: ['segment_1', 'book_1', 'chapter_1', 'tense', '2026-07-05T00:10:00.000Z'],
    });
    expect(materialized[4]).toMatchObject({
      sql: expect.stringContaining('delete from user_corrections'),
      params: ['correction_1', 'book_1'],
    });
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });

  it('materializes the user projection and invalidates server-derived casting until recompute', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const event = voiceCastingUpdatedEvent('2026-07-05T00:09:30.000Z');

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([event]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 1,
      acceptedIds: [event.id],
    });
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.sql).toContain('insert into voice_casting_states');
    expect(materialized[0]?.sql).toContain('state_payload = excluded.state_payload');
    expect(materialized[0]?.sql).toContain('derived_payload = excluded.derived_payload');
    expect(materialized[0]?.params?.[0]).toBe('user_test');
    expect(materialized[0]?.params?.[1]).toBe('book_1');
    expect(JSON.parse(String(materialized[0]?.params?.[3]))).toMatchObject({ status: 'staging', assignments: [] });
    expect(JSON.parse(String(materialized[0]?.params?.[4]))).toEqual({
      voiceProfileIds: ['voice_narrator'],
      pools: [],
      overrides: [],
      traitEvidence: [],
    });
    expect(JSON.parse(String(materialized[0]?.params?.[5]))).toEqual({
      importanceProfiles: [],
      traitEvidence: [],
      traitProfiles: [],
      pools: [],
      automaticAssignments: [],
      pinnedAssignments: [],
      reviews: [],
    });

    await app.close();
  });

  it('rejects stale, derived-injecting, and secret-like voice casting snapshots before persistence', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) {
          return { rowCount: 1, rows: [{ exists: true }] };
        }
        if (sql.includes('should_accept')) return { rowCount: 1, rows: [{ should_accept: false }] };
        if (sql.includes('insert into sync_events') || sql.includes('insert into voice_casting_states')) {
          throw new Error('rejected voice casting events must not be persisted');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const stale = voiceCastingUpdatedEvent('2026-07-04T00:00:00.000Z');
    const derived = canonicalV2Event({
      ...voiceCastingUpdatedEvent('2026-07-05T00:00:00.000Z'),
      id: 'voice_casting_derived_injection',
      payload: {
        ...(voiceCastingUpdatedEvent('2026-07-05T00:00:00.000Z').payload as Record<string, unknown>),
        derivedArtifacts: { assignments: [{ id: 'attacker_assignment' }] },
      },
    });
    const secret = canonicalV2Event({
      ...voiceCastingUpdatedEvent('2026-07-05T00:00:01.000Z'),
      id: 'voice_casting_secret_injection',
      payload: {
        version: 'voice-casting-v1',
        contentRevisionId: 'content_revision_1',
        storageRevision: 4,
        userArtifacts: {
          voiceProfileIds: ['Bearer secret-token-value'],
          pools: [],
          overrides: [],
          traitEvidence: [],
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([stale, derived, secret]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: stale.id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
        {
          id: derived.id,
          reason: 'invalid',
          message: 'voice_casting_updated must contain only a valid user-authored voice casting projection',
        },
        {
          id: secret.id,
          reason: 'invalid',
          message: 'voice_casting_updated must not contain secret-like keys or values',
        },
      ],
    });

    await app.close();
  });

  it('materializes generated character graph and chapter segment snapshots with preservation guards', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const events = [
      characterGraphUpdatedEvent('2026-07-05T00:11:00.000Z'),
      chapterSegmentsUpdatedEvent('2026-07-05T00:12:00.000Z'),
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(events),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 2,
      acceptedIds: events.map((event) => event.id),
    });
    expect(materialized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('delete from characters'),
          params: ['book_1', 'user_test', ['char_1']],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('insert into characters'),
          params: expect.arrayContaining(['char_1', 'book_1', 'user_test', 'Alex']),
        }),
        expect.objectContaining({
          sql: expect.stringContaining('delete from labeled_segments'),
          params: ['book_1', 'chapter_1', ['segment_1']],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('insert into labeled_segments'),
          params: expect.arrayContaining(['segment_1', 'book_1', 'chapter_1', 'paragraph_1']),
        }),
      ]),
    );
    expect(materialized.find((item) => item.sql.includes('delete from characters'))?.sql).toContain(
      'is_user_confirmed = false',
    );
    expect(materialized.find((item) => item.sql.includes('insert into characters'))?.sql).toContain(
      'characters.is_user_confirmed and excluded.is_user_confirmed = false',
    );
    expect(materialized.find((item) => item.sql.includes('delete from character_relations'))).toMatchObject({
      params: ['book_1'],
    });
    expect(materialized.find((item) => item.sql.includes('delete from labeled_segments'))?.sql).toContain(
      'is_user_corrected = false',
    );
    expect(materialized.find((item) => item.sql.includes('insert into labeled_segments'))?.sql).toContain(
      'labeled_segments.is_user_corrected = false or excluded.is_user_corrected = true',
    );
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });

  it('preserves relations for character-only replacement events', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const graphEvent = characterGraphUpdatedEvent('2026-07-05T00:11:00.000Z');
    const { relations: _relations, ...characterOnlyPayload } = graphEvent.payload as Record<
      string,
      SyncEvent['payload']
    >;
    const event = canonicalV2Event({
      ...graphEvent,
      id: 'event_character_only_update',
      payload: characterOnlyPayload,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([event]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 1,
      acceptedIds: [event.id],
    });
    expect(materialized.some((item) => item.sql.includes('delete from characters'))).toBe(true);
    expect(materialized.some((item) => item.sql.includes('delete from character_relations'))).toBe(false);

    await app.close();
  });

  it('materializes chapter segment patch events only inside the patched paragraph scope', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const event = chapterSegmentsUpdatedEvent('2026-07-05T00:12:00.000Z');
    const patchEvent = canonicalV2Event({
      ...event,
      id: 'event_chapter_segments_patch',
      payload: {
        ...(event.payload as Record<string, unknown>),
        mode: 'patch',
        paragraphIds: ['paragraph_1'],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([patchEvent]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 1,
      acceptedIds: [patchEvent.id],
    });
    const deleteQuery = materialized.find((item) => item.sql.includes('delete from labeled_segments'));
    expect(deleteQuery).toMatchObject({
      params: ['book_1', 'chapter_1', ['paragraph_1'], ['segment_1']],
    });
    expect(deleteQuery?.sql).toContain('paragraph_id = any($3::text[])');
    expect(deleteQuery?.sql).toContain('is_user_corrected = false');

    await app.close();
  });

  it('rejects stale or malformed voice profile sync snapshots before materializing', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) {
          return { rowCount: 1, rows: [{ exists: true }] };
        }
        if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('select exists(select 1 from paragraph_search'))
          return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('should_accept')) return { rowCount: 1, rows: [{ should_accept: false }] };
        if (
          sql.includes('insert into sync_events') ||
          sql.includes('delete from voice_profiles') ||
          sql.includes('insert into voice_profiles')
        ) {
          throw new Error('invalid voice profile events should not be logged or materialized');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const staleEvent = voiceProfilesUpdatedEvent('2026-07-04T00:00:00.000Z');
    const malformedEvent: SyncEvent = canonicalV2Event({
      ...voiceProfilesUpdatedEvent('2026-07-05T00:00:00.000Z'),
      id: 'event_voice_profiles_malformed',
      payload: { voiceProfiles: 'not an array' },
    });
    const secretValueEvent = voiceProfilesUpdatedEvent('2026-07-05T00:00:01.000Z');
    const secretValueProfile = {
      ...(secretValueEvent.payload as { voiceProfiles: Record<string, unknown>[] }).voiceProfiles[0],
      providerOptions: { instructions: 'Bearer secret-token-value' },
    };
    const secretPayloadEvent: SyncEvent = canonicalV2Event({
      ...secretValueEvent,
      id: 'event_voice_profiles_secret_value',
      payload: { voiceProfiles: [secretValueProfile] },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([staleEvent, malformedEvent, secretPayloadEvent]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: staleEvent.id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
        {
          id: malformedEvent.id,
          reason: 'invalid',
          message: 'voice_profiles_updated requires a voiceProfiles array',
        },
        {
          id: secretPayloadEvent.id,
          reason: 'invalid',
          message: 'voice profile providerOptions must not contain secret-like keys or values',
        },
      ],
    });
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });

  it('rolls back every event in a rejected compound label mutation', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const segmentSource = chapterSegmentsUpdatedEvent('2026-07-05T00:20:00.000Z');
    const correctionSource = userCorrectionCreatedEvent('2026-07-05T00:20:01.000Z');
    const segmentEvent = canonicalV2Event({
      ...segmentSource,
      id: 'compound_segment_event',
      payload: { ...(segmentSource.payload as Record<string, unknown>), compoundOperationId: 'operation_1' },
    });
    const correctionEvent = canonicalV2Event({
      ...correctionSource,
      id: 'compound_correction_event',
      payload: {
        compoundOperationId: 'operation_1',
        correction: {
          ...(correctionSource.payload as { correction: Record<string, unknown> }).correction,
          afterJson: '',
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([segmentEvent, correctionEvent]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        { id: segmentEvent.id, reason: 'invalid', message: expect.stringContaining('operation_1 was rejected') },
        { id: correctionEvent.id, reason: 'invalid', message: expect.stringContaining('operation_1 was rejected') },
      ],
    });
    expect(client.query).toHaveBeenCalledWith('rollback to savepoint sync_compound_operation');
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(materialized.some((item) => item.sql.includes('insert into labeled_segments'))).toBe(true);

    await app.close();
  });
});

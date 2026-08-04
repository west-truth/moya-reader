import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { aggregateSyncEntityId, voiceProfilesResourceRevision } from '@noveldesk/text-core/identity/sync';
import { appWithAIRoutes } from './ai-route-test-harness.js';

describe('AI artifact routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('stores and reads hosted characters, labeled segments, and corrections', async () => {
    const characters = new Map<string, Record<string, unknown>>();
    const voiceProfiles = new Map<string, Record<string, unknown>>();
    const segments = new Map<string, Record<string, unknown>>();
    const corrections = new Map<string, Record<string, unknown>>();
    const characterRelations: Record<string, unknown>[] = [
      {
        id: 'rel_1',
        book_id: 'book_1',
        source_character_id: 'char_1',
        target_character_id: 'char_2',
        relation_label: 'mentor',
        terms_used_by_source: ['teacher'],
        terms_used_by_target: ['student'],
        confidence: 0.7,
        evidence: ['chapter_1'],
      },
    ];
    const syncEvents: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select id from library_books')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [{ id: 'book_1' }] };
        }
        if (sql.includes('select c.book_id')) {
          expect(params).toEqual(['chapter_1', 'user_test']);
          return { rows: [{ book_id: 'book_1' }] };
        }
        if (sql.includes('book.active_content_revision_id') && sql.includes('from paragraph_search paragraph')) {
          expect(params).toEqual(['book_1', 'paragraph_1', 'user_test']);
          return {
            rows: [
              {
                active_content_revision_id: 'content_revision_1',
                chapter_index: 1,
                paragraph_index: 0,
                paragraph_id: 'paragraph_1',
                text_hash: 'paragraph_hash_1',
              },
            ],
          };
        }
        if (sql.includes('delete from characters')) {
          expect(params?.[0]).toBe('book_1');
          expect(params?.[1]).toBe('user_test');
          const keepIds = new Set((params?.[2] as string[]) ?? []);
          [...characters.keys()].forEach((id) => {
            if (!keepIds.has(id)) characters.delete(id);
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('insert into characters')) {
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            user_id: params?.[2],
            canonical_name: params?.[3],
            aliases: JSON.parse(String(params?.[4])),
            color: params?.[5],
            description: params?.[6],
            confidence: params?.[7],
            is_user_confirmed: params?.[8],
          };
          characters.set(String(row.id), row);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('from character_relations')) {
          expect(params).toEqual(['book_1']);
          return { rows: characterRelations };
        }
        if (sql.includes('from characters')) {
          return { rows: [...characters.values()] };
        }
        if (sql.includes('delete from voice_profiles')) {
          expect(params?.[0]).toBe('book_1');
          const keepIds = new Set((params?.[1] as string[]) ?? []);
          [...voiceProfiles.keys()].forEach((id) => {
            if (!keepIds.has(id)) voiceProfiles.delete(id);
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('insert into voice_profiles')) {
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            character_id: params?.[2],
            role: params?.[3],
            provider_id: params?.[4],
            provider_voice_id: params?.[5],
            provider_model: params?.[6],
            label: params?.[7],
            language: params?.[8],
            tone: params?.[9],
            speed: params?.[10],
            pitch: params?.[11],
            emotion_policy: params?.[12],
            provider_options: JSON.parse(String(params?.[13])),
            is_user_selected: params?.[14],
            created_at: '2026-07-05T00:00:00.000Z',
            updated_at: '2026-07-05T00:00:00.000Z',
          };
          voiceProfiles.set(String(row.id), row);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('from voice_profiles')) {
          return { rows: [...voiceProfiles.values()] };
        }
        if (sql.includes('delete from labeled_segments')) {
          expect(params?.[0]).toBe('chapter_1');
          expect(params?.[1]).toBe('book_1');
          const keepIds = new Set((params?.[2] as string[]) ?? []);
          [...segments.keys()].forEach((id) => {
            if (!keepIds.has(id)) segments.delete(id);
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('insert into labeled_segments')) {
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            chapter_id: params?.[2],
            paragraph_id: params?.[3],
            segment_index: params?.[4],
            start_offset: params?.[5],
            end_offset: params?.[6],
            segment_text_hash: params?.[7],
            segment_type: params?.[8],
            speaker_id: params?.[9],
            candidate_speakers: JSON.parse(String(params?.[10])),
            listener_ids: JSON.parse(String(params?.[11])),
            emotion: params?.[12],
            prosody_intent: params?.[13] ? JSON.parse(String(params[13])) : null,
            confidence: params?.[14],
            evidence: params?.[15],
            voice_profile_id: params?.[16],
            is_user_corrected: params?.[17],
          };
          segments.set(String(row.id), row);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('from labeled_segments')) {
          return { rows: [...segments.values()] };
        }
        if (sql.includes('insert into user_corrections')) {
          const row = {
            id: params?.[0],
            book_id: params?.[1],
            chapter_id: params?.[2],
            paragraph_id: params?.[3],
            segment_id: params?.[4],
            correction_type: params?.[5],
            before_json: JSON.parse(String(params?.[6])),
            after_json: JSON.parse(String(params?.[7])),
            apply_scope: params?.[8],
            created_at: params?.[12],
          };
          corrections.set(String(row.id), row);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('delete from user_corrections')) {
          corrections.delete(String(params?.[0]));
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('from user_corrections')) {
          return { rows: [...corrections.values()] };
        }
        if (sql.includes('insert into sync_events')) {
          syncEvents.push({
            id: params?.[0],
            user_id: params?.[1],
            device_id: params?.[2],
            type: params?.[3],
            book_id: params?.[4],
            entity_id: params?.[5],
            payload: JSON.parse(String(params?.[6])),
            revision: JSON.parse(String(params?.[7])),
            created_at: params?.[8],
          });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const characterPayload = {
      characters: [
        {
          id: 'char_1',
          novelId: 'wrong_book',
          canonicalName: '강현우',
          aliases: ['현우', '강 대리'],
          color: '#3b82f6',
          description: '주요 인물',
          confidence: 0.92,
          isUserConfirmed: false,
        },
      ],
    };
    const segmentPayload = {
      segments: [
        {
          id: 'seg_1',
          novelId: 'wrong_book',
          chapterId: 'wrong_chapter',
          paragraphId: 'paragraph_1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 8,
          segmentTextHash: 'hash_segment',
          type: 'quoted_dialogue',
          speakerId: 'char_1',
          candidateSpeakers: ['char_1'],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.88,
          evidence: '문맥상 char_1',
          voiceProfileId: 'voice_char_1',
          isUserCorrected: false,
        },
      ],
    };
    const voiceProfilePayload = {
      voiceProfiles: [
        {
          id: 'voice_char_1',
          novelId: 'wrong_book',
          characterId: 'char_1',
          role: 'character',
          providerId: 'system',
          providerVoiceId: 'ko-KR-local',
          label: '강현우 음성',
          language: 'ko-KR',
          tone: 'calm',
          speed: 1.05,
          providerOptions: { source: 'manual' },
          isUserSelected: true,
        },
      ],
    };
    const correctionPayload = {
      id: 'correction_1',
      novelId: 'wrong_book',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_1',
      segmentId: 'seg_1',
      correctionType: 'speaker',
      beforeJson: JSON.stringify({ speakerId: 'unknown' }),
      afterJson: JSON.stringify({ speakerId: 'char_1' }),
      applyScope: 'chapter',
      createdAt: '2026-07-05T00:10:00.000Z',
    };
    const emotionCorrectionPayload = {
      id: 'correction_2',
      novelId: 'wrong_book',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_1',
      segmentId: 'seg_1',
      correctionType: 'emotion',
      beforeJson: JSON.stringify({ emotion: 'neutral' }),
      afterJson: JSON.stringify({ emotion: 'tense' }),
      applyScope: 'future_pattern',
      createdAt: '2026-07-05T00:11:00.000Z',
    };

    await expect(
      app.inject({ method: 'PUT', url: '/api/books/book_1/characters', payload: characterPayload }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'PUT', url: '/api/books/book_1/voice-profiles', payload: voiceProfilePayload }),
    ).resolves.toMatchObject({ statusCode: 200 });
    const syncEventCountBeforeConflict = syncEvents.length;
    const staleVoiceResponse = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/voice-profiles',
      payload: { ...voiceProfilePayload, expectedRevision: 'stale-revision' },
    });
    expect(staleVoiceResponse.statusCode).toBe(409);
    expect(staleVoiceResponse.json()).toMatchObject({
      error: 'resource revision conflict',
      resourceKind: 'voice_profiles',
      expectedRevision: 'stale-revision',
      actualRevision: expect.any(String),
    });
    expect(syncEvents).toHaveLength(syncEventCountBeforeConflict);
    expect([...voiceProfiles.values()]).toHaveLength(1);
    await expect(
      app.inject({
        method: 'PUT',
        url: '/api/books/book_1/voice-profiles',
        payload: {
          ...voiceProfilePayload,
          expectedRevision: voiceProfilesResourceRevision(
            voiceProfilePayload.voiceProfiles.map((profile) => ({ ...profile, novelId: 'book_1' })),
          ),
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'PUT', url: '/api/books/book_1/characters', payload: characterPayload }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'PUT', url: '/api/chapters/chapter_1/segments', payload: segmentPayload }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'POST', url: '/api/books/book_1/corrections', payload: correctionPayload }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'POST', url: '/api/books/book_1/corrections', payload: emotionCorrectionPayload }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: 'DELETE', url: '/api/books/book_1/corrections/correction_1' }),
    ).resolves.toMatchObject({ statusCode: 200 });

    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/characters' })).json()).toEqual({
      characters: [
        expect.objectContaining({
          id: 'char_1',
          novelId: 'book_1',
          canonicalName: '강현우',
          aliases: ['현우', '강 대리'],
          confidence: 0.92,
        }),
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/character-graph' })).json()).toEqual({
      graph: {
        novelId: 'book_1',
        characters: [expect.objectContaining({ id: 'char_1', novelId: 'book_1' })],
        relations: [
          expect.objectContaining({
            id: 'rel_1',
            novelId: 'book_1',
            sourceCharacterId: 'char_1',
            targetCharacterId: 'char_2',
            relationLabel: 'mentor',
            termsUsedBySource: ['teacher'],
            termsUsedByTarget: ['student'],
            confidence: 0.7,
            evidence: ['chapter_1'],
          }),
        ],
      },
    });
    expect((await app.inject({ method: 'GET', url: '/api/books/book_1/voice-profiles' })).json()).toEqual({
      voiceProfiles: [
        expect.objectContaining({
          id: 'voice_char_1',
          novelId: 'book_1',
          characterId: 'char_1',
          providerId: 'system',
          providerVoiceId: 'ko-KR-local',
          speed: 1.05,
          providerOptions: { source: 'manual' },
        }),
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/api/chapters/chapter_1/segments' })).json()).toEqual({
      segments: [
        expect.objectContaining({
          id: 'seg_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          speakerId: 'char_1',
          candidateSpeakers: ['char_1'],
          voiceProfileId: 'voice_char_1',
        }),
      ],
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/books/book_1/corrections?chapterId=chapter_1' })).json(),
    ).toEqual({
      corrections: [
        expect.objectContaining({
          id: 'correction_2',
          correctionType: 'emotion',
          applyScope: 'future_pattern',
          afterJson: JSON.stringify({ emotion: 'tense' }),
        }),
      ],
    });
    expect(syncEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'voice_profiles_updated',
          book_id: 'book_1',
          entity_id: aggregateSyncEntityId({ entityType: 'voice_profiles', novelId: 'book_1' }),
        }),
        expect.objectContaining({
          type: 'user_correction_created',
          book_id: 'book_1',
          entity_id: 'correction_1',
        }),
        expect.objectContaining({
          type: 'user_correction_created',
          book_id: 'book_1',
          entity_id: 'correction_2',
        }),
        expect.objectContaining({
          type: 'user_correction_deleted',
          book_id: 'book_1',
          entity_id: 'correction_1',
          payload: expect.objectContaining({
            id: 'correction_1',
            deletedAt: expect.any(String),
          }),
          revision: expect.objectContaining({
            entityType: 'user_correction',
            entityId: 'correction_1',
            deletedAt: expect.any(String),
          }),
        }),
      ]),
    );

    await app.close();
  });

  it('stores direct hosted Character Graph relations with the graph route', async () => {
    const characters = new Map<string, Record<string, unknown>>();
    const characterRelations: Record<string, unknown>[] = [];
    const syncEvents: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select id from library_books')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [{ id: 'book_1' }] };
        }
        if (sql.includes('insert into characters')) {
          characters.set(String(params?.[0]), {
            id: params?.[0],
            book_id: params?.[1],
            user_id: params?.[2],
            canonical_name: params?.[3],
            aliases: JSON.parse(String(params?.[4])),
            color: params?.[5],
            description: params?.[6],
            confidence: params?.[7],
            is_user_confirmed: params?.[8],
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('delete from character_relations')) {
          expect(params).toEqual(['book_1']);
          characterRelations.length = 0;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('delete from characters')) {
          expect(params?.[0]).toBe('book_1');
          expect(params?.[1]).toBe('user_test');
          const keepIds = new Set((params?.[2] as string[]) ?? []);
          [...characters.keys()].forEach((id) => {
            if (!keepIds.has(id)) characters.delete(id);
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('insert into character_relations')) {
          characterRelations.push({
            id: params?.[0],
            book_id: params?.[1],
            source_character_id: params?.[2],
            target_character_id: params?.[3],
            relation_label: params?.[4],
            terms_used_by_source: JSON.parse(String(params?.[5])),
            terms_used_by_target: JSON.parse(String(params?.[6])),
            confidence: params?.[7],
            evidence: JSON.parse(String(params?.[8])),
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('insert into sync_events')) {
          syncEvents.push({
            type: params?.[3],
            book_id: params?.[4],
            entity_id: params?.[5],
            payload: JSON.parse(String(params?.[6])),
          });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/character-graph',
      payload: {
        graph: {
          characters: [
            {
              id: 'char_1',
              novelId: 'book_1',
              canonicalName: 'Hero',
              aliases: ['H'],
              color: '#123456',
              confidence: 0.9,
              isUserConfirmed: true,
            },
            {
              id: 'char_2',
              novelId: 'book_1',
              canonicalName: 'Mentor',
              aliases: [],
              color: '#654321',
              confidence: 0.8,
              isUserConfirmed: false,
            },
          ],
          relations: [
            {
              id: 'rel_1',
              novelId: 'book_1',
              sourceCharacterId: 'char_1',
              targetCharacterId: 'char_2',
              relationLabel: 'mentor',
              termsUsedBySource: ['teacher'],
              termsUsedByTarget: ['student'],
              confidence: 0.7,
              evidence: ['chapter_1'],
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      graph: {
        novelId: 'book_1',
        relations: [expect.objectContaining({ id: 'rel_1', sourceCharacterId: 'char_1', targetCharacterId: 'char_2' })],
      },
    });
    expect([...characters.keys()].sort()).toEqual(['char_1', 'char_2']);
    expect(characterRelations).toEqual([
      expect.objectContaining({ id: 'rel_1', source_character_id: 'char_1', target_character_id: 'char_2' }),
    ]);
    expect(syncEvents).toEqual([
      expect.objectContaining({
        type: 'character_graph_updated',
        book_id: 'book_1',
        entity_id: aggregateSyncEntityId({ entityType: 'character_graph', novelId: 'book_1' }),
        payload: {
          mode: 'replace',
          characters: expect.arrayContaining([expect.objectContaining({ id: 'char_1' })]),
          relations: [expect.objectContaining({ id: 'rel_1' })],
        },
      }),
    ]);
    await app.close();
  });

  it('rejects malformed AI payloads before writes', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select id from library_books')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [{ id: 'book_1' }] };
        }
        if (sql.includes('select c.book_id')) {
          expect(params).toEqual(['chapter_1', 'user_test']);
          return { rows: [{ book_id: 'book_1' }] };
        }
        throw new Error(`database write should not be reached: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const cases = [
      { method: 'PUT', url: '/api/books/book_1/characters', payload: { characters: [{ id: 'char_1' }] } },
      { method: 'PUT', url: '/api/books/book_1/voice-profiles', payload: { voiceProfiles: [{ id: 'voice_1' }] } },
      {
        method: 'PUT',
        url: '/api/books/book_1/voice-profiles',
        payload: {
          voiceProfiles: [
            {
              id: 'voice_secret',
              role: 'character',
              providerId: 'openai-tts',
              providerVoiceId: 'alloy',
              label: 'secret voice',
              speed: 1,
              isUserSelected: true,
              providerOptions: { apiKey: 'sk-proj-must-not-store' },
            },
          ],
        },
      },
      { method: 'PUT', url: '/api/chapters/chapter_1/segments', payload: { segments: [{ id: 'seg_1' }] } },
      { method: 'POST', url: '/api/books/book_1/corrections', payload: { id: 'correction_1' } },
      {
        method: 'POST',
        url: '/api/books/book_1/corrections',
        payload: {
          id: 'correction_bad_type',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          correctionType: 'mood',
          afterJson: JSON.stringify({ emotion: 'tense' }),
          applyScope: 'chapter',
          createdAt: '2026-07-05T00:12:00.000Z',
        },
      },
    ] as const;

    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        payload: item.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty('error');
    }

    await app.close();
  });
});

import Fastify from 'fastify';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyVoiceCastingState,
  createVoiceAssignmentOverride,
  createVoicePoolDefinition,
  type VoiceCastingStateV1,
} from '../../../../../src/providers/voice-casting';
import { createAcceptedSpeakerProvenance } from '../../../../../src/providers/speaker-attribution/accepted-speaker-provenance';
import { registerVoiceCastingRoutes } from './voice-casting-routes.js';
import { testConfig } from './ai-route-test-harness.js';

function state(): VoiceCastingStateV1 {
  return createEmptyVoiceCastingState({ bookId: 'book_1', contentRevisionId: 'content_1', status: 'active' });
}

const emptyUserArtifacts = { voiceProfileIds: [], pools: [], overrides: [], traitEvidence: [] };
const emptyDerivedArtifacts = { importanceProfiles: [], traitEvidence: [], traitProfiles: [], pools: [] };

async function appFor(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  await registerVoiceCastingRoutes(app, pool, testConfig());
  return app;
}

describe('voice casting routes', () => {
  it('returns an empty authoritative state only for a book owned by the default user', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('select id from library_books')) {
        expect(values).toEqual(['book_1', 'user_test']);
        return { rows: [{ id: 'book_1' }] };
      }
      if (sql.includes('from voice_casting_states')) {
        expect(values).toEqual(['user_test', 'book_1']);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await appFor({ query } as unknown as pg.Pool);

    const response = await app.inject({ method: 'GET', url: '/api/books/book_1/voice-casting' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      revision: 0,
      state: null,
      userArtifacts: null,
      derivedArtifacts: null,
    });
    await app.close();
  });

  it('returns 404 for an unowned book without reading casting state', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql).toContain('select id from library_books');
      expect(values).toEqual(['book_other', 'user_test']);
      return { rows: [] };
    });
    const app = await appFor({ query } as unknown as pg.Pool);

    const response = await app.inject({ method: 'GET', url: '/api/books/book_other/voice-casting' });

    expect(response.statusCode).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('writes user-authored and derived projections separately and returns the incremented revision', async () => {
    let insertedValues: unknown[] | undefined;
    const poolDefinition = createVoicePoolDefinition({
      bookId: 'book_1',
      contentRevisionId: 'content_1',
      providerId: 'openai-tts',
      key: 'extras',
      voiceProfileIds: [],
      traitFilter: {},
      narratorExcluded: true,
      status: 'active',
      userPinned: true,
    });
    const assignmentOverride = createVoiceAssignmentOverride({
      bookId: 'book_1',
      contentRevisionId: 'content_1',
      speakerEntityId: 'speaker_1',
      voiceIdentityId: 'voice_identity_1',
      voiceProfileId: 'voice_profile_1',
      reasonCode: 'user_selection',
      effectiveFromOrder: 0,
      effectiveFromSceneId: 'scene_1',
      status: 'active',
    });
    const requestedState = state();
    const userArtifacts = {
      ...emptyUserArtifacts,
      pools: [poolDefinition],
      overrides: [assignmentOverride],
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('select id from library_books')) return { rows: [{ id: 'book_1' }] };
      if (sql.includes('insert into voice_casting_states')) {
        insertedValues = values;
        return {
          rows: [
            {
              revision: 1,
              state_payload: requestedState,
              user_authored_payload: JSON.parse(String(values?.[5])),
              derived_payload: JSON.parse(String(values?.[6])),
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await appFor({ query } as unknown as pg.Pool);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/voice-casting',
      payload: {
        expectedRevision: 0,
        state: requestedState,
        userArtifacts,
        derivedArtifacts: emptyDerivedArtifacts,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      revision: 1,
      state: requestedState,
      userArtifacts,
      derivedArtifacts: {
        ...emptyDerivedArtifacts,
        automaticAssignments: [],
        pinnedAssignments: [],
        reviews: [],
      },
    });
    expect(JSON.parse(String(insertedValues?.[5]))).toEqual(userArtifacts);
    expect(JSON.parse(String(insertedValues?.[6]))).toEqual({
      ...emptyDerivedArtifacts,
      automaticAssignments: [],
      pinnedAssignments: [],
      reviews: [],
    });
    await app.close();
  });

  it('returns 409 for stale CAS and rejects secret-like payloads before persistence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('select id from library_books')) return { rows: [{ id: 'book_1' }] };
      if (sql.includes('insert into voice_casting_states')) return { rows: [] };
      if (sql.includes('from voice_casting_states')) {
        return {
          rows: [
            {
              revision: 4,
              state_payload: state(),
              user_authored_payload: emptyUserArtifacts,
              derived_payload: emptyDerivedArtifacts,
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await appFor({ query } as unknown as pg.Pool);

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/voice-casting',
      payload: {
        expectedRevision: 3,
        state: state(),
        userArtifacts: emptyUserArtifacts,
        derivedArtifacts: emptyDerivedArtifacts,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: 'voice casting revision changed',
      expectedRevision: 3,
      revision: 4,
    });

    const secret = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/voice-casting',
      payload: {
        expectedRevision: 4,
        state: state(),
        userArtifacts: { ...emptyUserArtifacts, providerOptions: { apiKey: 'sk-secret-value' } },
        derivedArtifacts: emptyDerivedArtifacts,
      },
    });
    expect(secret.statusCode).toBe(400);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('insert into voice_casting_states'))).toHaveLength(
      1,
    );
    await app.close();
  });

  it('projects active accepted spans without collapsing an unknown canonical speaker entity', async () => {
    const provenance = createAcceptedSpeakerProvenance(
      {
        bookId: 'book_1',
        contentRevisionId: 'content_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        segmentId: 'segment_1',
        sourceSpanId: 'span_1',
        sceneId: 'scene_1',
        narrativeOrder: 7,
        speakerEntityId: 'pending_extra_1',
        canonicalSpeakerId: 'unknown',
        resolutionKind: 'provider_new_mention',
        sourceManifestFingerprint: 'manifest_1',
        confidence: 0.8,
      },
      'artifact_1',
      '2026-07-13T00:00:00.000Z',
    );
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('select id from library_books')) return { rows: [{ id: 'book_1' }] };
      if (sql.includes('from accepted_speaker_provenance')) {
        expect(sql).toContain("provenance.status = 'active'");
        expect(sql).toContain('book.active_content_revision_id = provenance.content_revision_id');
        expect(values).toEqual(['user_test', 'book_1']);
        return { rows: [{ provenance, start_offset: 3, end_offset: 8 }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await appFor({ query } as unknown as pg.Pool);

    const response = await app.inject({ method: 'GET', url: '/api/books/book_1/voice-casting/source' });

    expect(response.statusCode).toBe(200);
    expect(response.json().utterances).toEqual([
      expect.objectContaining({
        speakerEntityId: 'pending_extra_1',
        canonicalSpeakerId: 'unknown',
        sourceStartOffset: 3,
        sourceEndOffset: 8,
        spokenCharacterCount: 5,
      }),
    ]);
    await app.close();
  });
});

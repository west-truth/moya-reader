import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { VOICE_CASTING_VERSION, type VoiceCastingStateV1 } from '../../../../src/providers/voice-casting';
import {
  loadHostedVoiceCastingState,
  saveHostedVoiceCastingState,
  VoiceCastingRevisionConflictError,
  type VoiceCastingStateQueryable,
} from './voice-casting-state-service.js';

function state(bookId = 'book_1'): VoiceCastingStateV1 {
  return {
    version: VOICE_CASTING_VERSION,
    id: 'casting_1',
    bookId,
    contentRevisionId: 'content_1',
    revision: 'casting_revision_1',
    fingerprint: 'casting_fingerprint_1',
    importanceRevision: 'importance_1',
    traitRevision: 'trait_1',
    poolRevision: 'pool_1',
    voiceProfileRevision: 'profiles_1',
    assignmentRevision: 'assignments_1',
    assignments: [],
    reviews: [],
    status: 'active',
    userPinned: false,
  };
}

function memoryDb(): VoiceCastingStateQueryable {
  let row:
    | {
        revision: number;
        state_payload: VoiceCastingStateV1;
        user_authored_payload: Readonly<Record<string, unknown>>;
        derived_payload: Readonly<Record<string, unknown>>;
      }
    | undefined;
  return {
    query: async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => {
      if (sql.includes('insert into voice_casting_states')) {
        const expected = Number(values[3]);
        if ((!row && expected !== 0) || (row && row.revision !== expected)) {
          return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
        }
        row = {
          revision: row ? row.revision + 1 : 1,
          state_payload: JSON.parse(String(values[4])) as VoiceCastingStateV1,
          user_authored_payload: JSON.parse(String(values[5])) as Readonly<Record<string, unknown>>,
          derived_payload: JSON.parse(String(values[6])) as Readonly<Record<string, unknown>>,
        };
        return { rows: [row], rowCount: 1 } as unknown as pg.QueryResult<T>;
      }
      if (sql.includes('from voice_casting_states')) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as unknown as pg.QueryResult<T>;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

describe('voice casting state service', () => {
  it('creates revision one and increments only through matching CAS writes', async () => {
    const db = memoryDb();
    const projections = { userAuthored: { poolDefinitions: [] }, derived: { assignments: [] } };

    expect(await loadHostedVoiceCastingState(db, 'user_1', 'book_1')).toEqual({
      revision: 0,
      state: null,
      userArtifacts: null,
      derivedArtifacts: null,
    });
    expect(
      await saveHostedVoiceCastingState(db, {
        userId: 'user_1',
        bookId: 'book_1',
        expectedRevision: 0,
        state: state(),
        projections,
      }),
    ).toEqual({
      revision: 1,
      state: state(),
      userArtifacts: projections.userAuthored,
      derivedArtifacts: projections.derived,
    });
    expect(
      await saveHostedVoiceCastingState(db, {
        userId: 'user_1',
        bookId: 'book_1',
        expectedRevision: 1,
        state: { ...state(), revision: 'casting_revision_2' },
        projections,
      }),
    ).toEqual({
      revision: 2,
      state: { ...state(), revision: 'casting_revision_2' },
      userArtifacts: projections.userAuthored,
      derivedArtifacts: projections.derived,
    });
  });

  it('reports the current revision after a stale write', async () => {
    const db = memoryDb();
    const projections = { userAuthored: {}, derived: {} };
    await saveHostedVoiceCastingState(db, {
      userId: 'user_1',
      bookId: 'book_1',
      expectedRevision: 0,
      state: state(),
      projections,
    });

    await expect(
      saveHostedVoiceCastingState(db, {
        userId: 'user_1',
        bookId: 'book_1',
        expectedRevision: 0,
        state: state(),
        projections,
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<VoiceCastingRevisionConflictError>>({ currentRevision: 1 }));
  });
});

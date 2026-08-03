import type pg from 'pg';
import type { VoiceCastingStateV1 } from '../../../../src/providers/voice-casting/contracts';

export interface VoiceCastingStateQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

export interface HostedVoiceCastingState {
  readonly revision: number;
  readonly state: VoiceCastingStateV1 | null;
  readonly userArtifacts: Readonly<Record<string, unknown>> | null;
  readonly derivedArtifacts: Readonly<Record<string, unknown>> | null;
}

export interface VoiceCastingStateProjections {
  readonly userAuthored: Readonly<Record<string, unknown>>;
  readonly derived: Readonly<Record<string, unknown>>;
}

interface VoiceCastingStateRow extends pg.QueryResultRow {
  revision: number | string;
  state_payload: VoiceCastingStateV1;
  user_authored_payload: Readonly<Record<string, unknown>>;
  derived_payload: Readonly<Record<string, unknown>>;
}

function revisionNumber(value: number | string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Persisted voice casting revision is invalid');
  }
  return revision;
}

export class VoiceCastingRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super('Voice casting revision changed');
    this.name = 'VoiceCastingRevisionConflictError';
  }
}

export async function loadHostedVoiceCastingState(
  db: VoiceCastingStateQueryable,
  userId: string,
  bookId: string,
): Promise<HostedVoiceCastingState> {
  const result = await db.query<VoiceCastingStateRow>(
    `
      select revision, state_payload, user_authored_payload, derived_payload
      from voice_casting_states
      where user_id = $1 and book_id = $2
    `,
    [userId, bookId],
  );
  const row = result.rows[0];
  return row
    ? {
        revision: revisionNumber(row.revision),
        state: row.state_payload,
        userArtifacts: row.user_authored_payload,
        derivedArtifacts: row.derived_payload,
      }
    : { revision: 0, state: null, userArtifacts: null, derivedArtifacts: null };
}

export async function saveHostedVoiceCastingState(
  db: VoiceCastingStateQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly expectedRevision: number;
    readonly state: VoiceCastingStateV1;
    readonly projections: VoiceCastingStateProjections;
  },
): Promise<HostedVoiceCastingState> {
  const result = await db.query<VoiceCastingStateRow>(
    `
      insert into voice_casting_states (
        user_id, book_id, version, revision, state_payload, user_authored_payload, derived_payload,
        created_at, updated_at
      )
      select $1, $2, $3, 1, $5::jsonb, $6::jsonb, $7::jsonb, now(), now()
      where $4::integer = 0
      on conflict (user_id, book_id) do update
        set version = excluded.version,
            revision = voice_casting_states.revision + 1,
            state_payload = excluded.state_payload,
            user_authored_payload = excluded.user_authored_payload,
            derived_payload = excluded.derived_payload,
            updated_at = now()
        where voice_casting_states.revision = $4::integer
      returning revision, state_payload, user_authored_payload, derived_payload
    `,
    [
      input.userId,
      input.bookId,
      input.state.version,
      input.expectedRevision,
      JSON.stringify(input.state),
      JSON.stringify(input.projections.userAuthored),
      JSON.stringify(input.projections.derived),
    ],
  );
  const row = result.rows[0];
  if (row) {
    return {
      revision: revisionNumber(row.revision),
      state: row.state_payload,
      userArtifacts: row.user_authored_payload,
      derivedArtifacts: row.derived_payload,
    };
  }

  const current = await loadHostedVoiceCastingState(db, input.userId, input.bookId);
  throw new VoiceCastingRevisionConflictError(input.expectedRevision, current.revision);
}

import type pg from 'pg';
import type { VoiceCastingStateV1, VoicePoolAssignmentV1 } from '../../../../src/providers/voice-casting/contracts';
import { compareText, includesNarrativeOrder } from '../../../../src/providers/voice-casting/artifact';
import { actualProviderVoiceKey } from '../../../../src/providers/voice-casting/pools';

export interface VoiceCastingTTSGuardQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface VoiceCastingScopeRow extends pg.QueryResultRow {
  active_content_revision_id: string | null;
  state_payload: VoiceCastingStateV1 | null;
}

interface AcceptedSpeakerRow extends pg.QueryResultRow {
  id: string;
  segment_id: string;
  narrative_order: number | string;
  speaker_entity_id: string | null;
}

interface VoiceProfileProviderRow extends pg.QueryResultRow {
  id: string;
  provider_id: string;
  provider_model: string | null;
  provider_voice_id: string;
}

function activeAssignmentFor(
  assignments: readonly VoicePoolAssignmentV1[],
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly speakerEntityId: string;
    readonly narrativeOrder: number;
    readonly requestedProviderId: string;
    readonly providerIdByVoiceProfileId: ReadonlyMap<string, string>;
  },
): VoicePoolAssignmentV1 | undefined {
  return assignments
    .filter(
      (candidate) =>
        candidate.status === 'active' &&
        candidate.bookId === input.bookId &&
        candidate.contentRevisionId === input.contentRevisionId &&
        candidate.speakerEntityId === input.speakerEntityId &&
        input.providerIdByVoiceProfileId.get(candidate.voiceProfileId) === input.requestedProviderId &&
        includesNarrativeOrder(candidate, input.narrativeOrder),
    )
    .sort(
      (left, right) =>
        Number(right.userPinned) - Number(left.userPinned) ||
        right.effectiveFromOrder - left.effectiveFromOrder ||
        compareText(left.id, right.id),
    )[0];
}

export async function hasStaleHostedTTSVoiceCasting(
  db: VoiceCastingTTSGuardQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId: string;
    readonly segmentIds: readonly string[];
    readonly speakerId: string;
    readonly voiceProfileId: string;
    readonly requestedProviderId: string;
  },
): Promise<boolean> {
  const casting = await db.query<VoiceCastingScopeRow>(
    `
      select book.active_content_revision_id, casting.state_payload
      from library_books book
      left join voice_casting_states casting
        on casting.book_id = book.id
       and casting.user_id = book.user_id
      where book.user_id = $1
        and book.id = $2
    `,
    [input.userId, input.bookId],
  );
  const authoritative = casting.rows[0];
  const contentRevisionId = authoritative?.active_content_revision_id;
  const state = authoritative?.state_payload;
  if (!state) return false;
  if (!contentRevisionId || state.contentRevisionId !== contentRevisionId || state.status !== 'active') return true;

  const accepted = await db.query<AcceptedSpeakerRow>(
    `
      select id, segment_id, narrative_order, speaker_entity_id
      from accepted_speaker_provenance
      where user_id = $1
        and book_id = $2
        and content_revision_id = $3
        and chapter_id = $4
        and status = 'active'
        and segment_id = any($5::text[])
      order by narrative_order, id
    `,
    [input.userId, input.bookId, contentRevisionId, input.chapterId, [...input.segmentIds]],
  );
  const roleSpeaker = ['narrator', 'system', 'unknown'].includes(input.speakerId);
  if (accepted.rows.length === 0) return !roleSpeaker;
  const acceptedSegmentIds = new Set(accepted.rows.map((row) => row.segment_id));
  if (!roleSpeaker && [...new Set(input.segmentIds)].some((segmentId) => !acceptedSegmentIds.has(segmentId))) {
    return true;
  }

  const assignmentVoiceProfileIds = [...new Set(state.assignments.map((assignment) => assignment.voiceProfileId))];
  if (assignmentVoiceProfileIds.length === 0) return true;
  const assignmentProfiles = await db.query<VoiceProfileProviderRow>(
    `
      select profile.id, profile.provider_id, profile.provider_model, profile.provider_voice_id
      from voice_profiles profile
      join library_books book on book.id = profile.book_id
      where book.user_id = $1
        and profile.book_id = $2
        and profile.id = any($3::text[])
    `,
    [input.userId, input.bookId, assignmentVoiceProfileIds],
  );
  const providerIdByVoiceProfileId = new Map(
    assignmentProfiles.rows.map((profile) => [profile.id, profile.provider_id] as const),
  );
  const profileById = new Map(assignmentProfiles.rows.map((profile) => [profile.id, profile] as const));

  return accepted.rows.some((row) => {
    const narrativeOrder = Number(row.narrative_order);
    if (!Number.isSafeInteger(narrativeOrder) || narrativeOrder < 0) {
      throw new Error('Persisted accepted speaker narrative order is invalid');
    }
    const speakerEntityId = row.speaker_entity_id ?? `unknown:${row.id}`;
    const assignment = activeAssignmentFor(state.assignments, {
      bookId: input.bookId,
      contentRevisionId,
      speakerEntityId,
      narrativeOrder,
      requestedProviderId: input.requestedProviderId,
      providerIdByVoiceProfileId,
    });
    const profile = assignment ? profileById.get(assignment.voiceProfileId) : undefined;
    return (
      assignment === undefined ||
      profile === undefined ||
      assignment.voiceProfileId !== input.voiceProfileId ||
      assignment.actualVoiceKey !==
        actualProviderVoiceKey({
          providerId: profile.provider_id,
          providerModel: profile.provider_model ?? undefined,
          providerVoiceId: profile.provider_voice_id,
        })
    );
  });
}

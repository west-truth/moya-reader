import { describe, expect, it, vi } from 'vitest';
import type { VoicePoolAssignmentV1 } from '../../../../src/providers/voice-casting/contracts';
import { hasStaleHostedTTSVoiceCasting, type VoiceCastingTTSGuardQueryable } from './voice-casting-tts-guard.js';

function assignment(
  id: string,
  speakerEntityId: string,
  voiceProfileId: string,
  effectiveFromOrder: number,
  userPinned = false,
  providerId = 'local-endpoint',
): VoicePoolAssignmentV1 {
  return {
    version: 'voice-casting-v1',
    id,
    bookId: 'book_1',
    contentRevisionId: 'content_1',
    revision: `${id}_revision`,
    fingerprint: `${id}_fingerprint`,
    speakerEntityId,
    voiceIdentityId: `${id}_identity`,
    voiceTier: userPinned ? 'A_dedicated' : 'B_stable_pool',
    voiceProfileId,
    actualVoiceKey: `${encodeURIComponent(providerId)}||${encodeURIComponent(voiceProfileId)}`,
    method: userPinned ? 'user' : 'stable_hash',
    retroactiveRerender: false,
    effectiveFromOrder,
    effectiveFromSceneId: 'scene_1',
    status: 'active',
    userPinned,
  };
}

function guardDb(input: {
  readonly assignments?: readonly VoicePoolAssignmentV1[];
  readonly accepted?: readonly Record<string, unknown>[];
  readonly hasCastingState?: boolean;
  readonly contentRevisionId?: string;
  readonly stateStatus?: 'staging' | 'active' | 'stale';
  readonly profileProviders?: Readonly<Record<string, string>>;
}): { readonly db: VoiceCastingTTSGuardQueryable; readonly query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('voice_casting_states')) {
      expect(values).toEqual(['user_1', 'book_1']);
      return input.hasCastingState === false
        ? { rows: [] }
        : {
            rows: [
              {
                active_content_revision_id: 'content_1',
                state_payload: {
                  contentRevisionId: input.contentRevisionId ?? 'content_1',
                  status: input.stateStatus ?? 'active',
                  assignments: input.assignments ?? [],
                },
              },
            ],
          };
    }
    if (sql.includes('from accepted_speaker_provenance')) {
      expect(sql).toContain("status = 'active'");
      expect(values?.slice(0, 4)).toEqual(['user_1', 'book_1', 'content_1', 'chapter_1']);
      return { rows: input.accepted ?? [] };
    }
    if (sql.includes('select profile.id, profile.provider_id')) {
      const voiceProfileIds = values?.[2] as string[];
      expect(values?.slice(0, 2)).toEqual(['user_1', 'book_1']);
      return {
        rows: voiceProfileIds.map((id) => ({
          id,
          provider_id: input.profileProviders?.[id] ?? 'local-endpoint',
          provider_model: null,
          provider_voice_id: id,
        })),
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { db: { query } as unknown as VoiceCastingTTSGuardQueryable, query };
}

const request = {
  userId: 'user_1',
  bookId: 'book_1',
  chapterId: 'chapter_1',
  segmentIds: ['segment_1'],
  speakerId: 'speaker_1',
  voiceProfileId: 'voice_requested',
  requestedProviderId: 'local-endpoint',
} as const;

describe('hosted TTS voice casting guard', () => {
  it('allows the matching user-pinned assignment using projection precedence', async () => {
    const { db } = guardDb({
      assignments: [
        assignment('auto_latest', 'speaker_1', 'voice_other', 11),
        assignment('pin_old', 'speaker_1', 'voice_other', 0, true),
        assignment('pin_current', 'speaker_1', 'voice_requested', 5, true),
      ],
      accepted: [{ id: 'accepted_1', segment_id: 'segment_1', narrative_order: 12, speaker_entity_id: 'speaker_1' }],
    });

    await expect(hasStaleHostedTTSVoiceCasting(db, request)).resolves.toBe(false);
  });

  it('rejects a multi-segment request when any active assignment conflicts', async () => {
    const { db } = guardDb({
      assignments: [
        assignment('assignment_1', 'speaker_1', 'voice_requested', 0),
        assignment('assignment_2', 'speaker_2', 'voice_other', 0),
      ],
      accepted: [
        { id: 'accepted_1', segment_id: 'segment_1', narrative_order: 1, speaker_entity_id: 'speaker_1' },
        { id: 'accepted_2', segment_id: 'segment_2', narrative_order: 2, speaker_entity_id: 'speaker_2' },
      ],
    });

    await expect(
      hasStaleHostedTTSVoiceCasting(db, { ...request, segmentIds: ['segment_1', 'segment_2'] }),
    ).resolves.toBe(true);
  });

  it('allows legacy TTS when no authoritative casting state exists', async () => {
    const { db, query } = guardDb({ hasCastingState: false });

    await expect(hasStaleHostedTTSVoiceCasting(db, request)).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects staging or content-mismatched casting state until it is rebuilt', async () => {
    const { db: stagingDb } = guardDb({ stateStatus: 'staging' });
    const { db: revisionDb } = guardDb({ contentRevisionId: 'content_old' });

    await expect(hasStaleHostedTTSVoiceCasting(stagingDb, request)).resolves.toBe(true);
    await expect(hasStaleHostedTTSVoiceCasting(revisionDb, request)).resolves.toBe(true);
  });

  it('rejects a character segment without accepted provenance but allows narration fallback', async () => {
    const { db: characterDb } = guardDb({ accepted: [] });
    const { db: narratorDb } = guardDb({ accepted: [] });

    await expect(hasStaleHostedTTSVoiceCasting(characterDb, request)).resolves.toBe(true);
    await expect(hasStaleHostedTTSVoiceCasting(narratorDb, { ...request, speakerId: 'narrator' })).resolves.toBe(false);
  });

  it('uses distinct speakerEntityId values for canonical unknown speakers', async () => {
    const { db } = guardDb({
      assignments: [
        assignment('unknown_1', 'pending_extra_1', 'voice_other', 0),
        assignment('unknown_2', 'pending_extra_2', 'voice_requested', 0),
      ],
      accepted: [
        {
          id: 'accepted_unknown_1',
          segment_id: 'segment_1',
          narrative_order: 1,
          speaker_entity_id: 'pending_extra_1',
        },
        {
          id: 'accepted_unknown_2',
          segment_id: 'segment_2',
          narrative_order: 2,
          speaker_entity_id: 'pending_extra_2',
        },
      ],
    });

    await expect(hasStaleHostedTTSVoiceCasting(db, request)).resolves.toBe(true);
  });

  it('rejects a request when only a cross-provider assignment exists', async () => {
    const { db: hostedDb } = guardDb({
      assignments: [assignment('system_assignment', 'speaker_1', 'voice_system', 0, true, 'system')],
      profileProviders: { voice_system: 'system' },
      accepted: [{ id: 'accepted_1', segment_id: 'segment_1', narrative_order: 1, speaker_entity_id: 'speaker_1' }],
    });
    const { db: systemDb } = guardDb({
      assignments: [assignment('hosted_assignment', 'speaker_1', 'voice_hosted', 0, true)],
      profileProviders: { voice_hosted: 'local-endpoint' },
      accepted: [{ id: 'accepted_1', segment_id: 'segment_1', narrative_order: 1, speaker_entity_id: 'speaker_1' }],
    });

    await expect(hasStaleHostedTTSVoiceCasting(hostedDb, request)).resolves.toBe(true);
    await expect(
      hasStaleHostedTTSVoiceCasting(systemDb, {
        ...request,
        voiceProfileId: 'voice_system',
        requestedProviderId: 'system',
      }),
    ).resolves.toBe(true);
  });

  it('applies precedence after provider filtering when provider drafts coexist', async () => {
    const { db } = guardDb({
      assignments: [
        assignment('system_pin', 'speaker_1', 'voice_system', 5, true),
        assignment('hosted_assignment', 'speaker_1', 'voice_hosted_current', 0),
      ],
      profileProviders: { voice_system: 'system', voice_hosted_current: 'local-endpoint' },
      accepted: [{ id: 'accepted_1', segment_id: 'segment_1', narrative_order: 7, speaker_entity_id: 'speaker_1' }],
    });

    await expect(hasStaleHostedTTSVoiceCasting(db, request)).resolves.toBe(true);
  });
});

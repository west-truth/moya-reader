import { describe, expect, it, vi } from 'vitest';
import { loadAiTtsRemoteSnapshot } from '../sync/ai-tts-remote-snapshot';
import { summarizeAiTtsSyncConflictGroups } from '../sync/sync-ui';
import type { SyncOutboxItem } from '../sync/types';

function outboxItem(
  id: string,
  type: SyncOutboxItem['event']['type'],
  payload: SyncOutboxItem['event']['payload'],
  entityId: string,
): SyncOutboxItem {
  return {
    id,
    event: {
      id: `event-${id}`,
      type,
      deviceId: 'local-device',
      novelId: 'book_1',
      entityId,
      payload,
      createdAt: '2026-07-06T00:00:00.000Z',
      revision: {
        entityType:
          type === 'chapter_segments_updated'
            ? 'chapter_segments'
            : type === 'voice_profiles_updated'
              ? 'voice_profiles'
              : type === 'character_graph_updated'
                ? 'character_graph'
                : 'user_correction',
        entityId,
        novelId: 'book_1',
        localSequence: 1,
        updatedAt: '2026-07-06T00:00:00.000Z',
        payloadHash: `hash-${id}`,
      },
    },
    status: 'failed',
    localSequence: 1,
    attempts: 1,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  };
}

function fakeClient() {
  return {
    listVoiceProfiles: vi.fn(async () => ({
      voiceProfiles: [
        {
          id: 'voice_1',
          novelId: 'book_1',
          role: 'narrator' as const,
          providerId: 'system',
          providerVoiceId: 'ko-KR',
          label: 'Narrator',
          speed: 1,
          isUserSelected: true,
        },
      ],
    })),
    listCharacters: vi.fn(async () => ({
      characters: [
        {
          id: 'char_1',
          novelId: 'book_1',
          canonicalName: 'Hero',
          aliases: [],
          color: '#123456',
          confidence: 0.9,
          isUserConfirmed: true,
        },
      ],
    })),
    listCharacterGraph: vi.fn(async () => ({
      graph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'char_1',
            novelId: 'book_1',
            canonicalName: 'Hero',
            aliases: [],
            color: '#123456',
            confidence: 0.9,
            isUserConfirmed: true,
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
    })),
    listSegments: vi.fn(async () => ({
      segments: [
        {
          id: 'segment_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 5,
          segmentTextHash: 'hash',
          type: 'quoted_dialogue' as const,
          speakerId: 'char_1',
          candidateSpeakers: ['char_1'],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.8,
          isUserCorrected: false,
        },
      ],
    })),
    listCorrections: vi.fn(async () => ({
      corrections: [
        {
          id: 'correction_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          segmentId: 'segment_1',
          correctionType: 'speaker' as const,
          afterJson: JSON.stringify({ speakerId: 'char_1' }),
          applyScope: 'chapter' as const,
          createdAt: '2026-07-06T00:00:00.000Z',
        },
        {
          id: 'correction_2',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          segmentId: 'segment_2',
          correctionType: 'emotion' as const,
          afterJson: JSON.stringify({ emotion: 'tense' }),
          applyScope: 'chapter' as const,
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    })),
  };
}

describe('AI/TTS remote snapshot loader', () => {
  it('loads remote voice profiles for a voice-profile sync group', async () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem('voice', 'voice_profiles_updated', { voiceProfiles: [] }, 'voice_profiles_book_1'),
    ]);
    const client = fakeClient();

    await expect(loadAiTtsRemoteSnapshot(client, group!)).resolves.toMatchObject({
      voiceProfiles: [expect.objectContaining({ id: 'voice_1', providerId: 'system' })],
    });
    expect(client.listVoiceProfiles).toHaveBeenCalledWith('book_1');
  });

  it('loads chapter-scoped remote segments and corrections from group payloads', async () => {
    const [segmentGroup] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'segments',
        'chapter_segments_updated',
        { chapterId: 'chapter_1', segments: [] },
        'chapter_segments_chapter_1',
      ),
    ]);
    const [correctionGroup] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'correction',
        'user_correction_created',
        {
          correction: {
            id: 'correction_local',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            segmentId: 'segment_1',
            correctionType: 'speaker',
            afterJson: '{}',
            applyScope: 'chapter',
            createdAt: '2026-07-06T00:00:00.000Z',
          },
        },
        'correction_local',
      ),
    ]);
    const client = fakeClient();

    await expect(loadAiTtsRemoteSnapshot(client, segmentGroup!)).resolves.toMatchObject({
      segments: [expect.objectContaining({ id: 'segment_1' })],
    });
    await expect(loadAiTtsRemoteSnapshot(client, correctionGroup!)).resolves.toMatchObject({
      corrections: expect.arrayContaining([expect.objectContaining({ id: 'correction_1' })]),
    });
    expect(client.listSegments).toHaveBeenCalledWith('chapter_1');
    expect(client.listCorrections).toHaveBeenCalledWith('book_1', { chapterId: 'chapter_1' });
  });

  it('loads only the target remote correction for a deletion sync group', async () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'correction-delete',
        'user_correction_deleted',
        {
          id: 'correction_2',
          deletedAt: '2026-07-06T00:05:00.000Z',
        },
        'correction_2',
      ),
    ]);
    const client = fakeClient();

    await expect(loadAiTtsRemoteSnapshot(client, group!)).resolves.toMatchObject({
      corrections: [expect.objectContaining({ id: 'correction_2' })],
    });
    expect(client.listCorrections).toHaveBeenCalledWith('book_1');
  });

  it('loads remote characters for a character-graph sync group', async () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem('graph', 'character_graph_updated', { characters: [] }, 'character_graph_book_1'),
    ]);
    const client = fakeClient();

    await expect(loadAiTtsRemoteSnapshot(client, group!)).resolves.toMatchObject({
      characters: [expect.objectContaining({ id: 'char_1', canonicalName: 'Hero' })],
      relations: [expect.objectContaining({ id: 'rel_1', relationLabel: 'mentor' })],
    });
    expect(client.listCharacterGraph).toHaveBeenCalledWith('book_1');
    expect(client.listCharacters).not.toHaveBeenCalled();
  });
});

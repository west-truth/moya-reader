import { describe, expect, it } from 'vitest';
import { buildAiTtsSyncSnapshotPreview } from '../sync/ai-tts-sync-diff';
import type { SyncOutboxItem } from '../sync/types';

function outboxItem(
  id: string,
  type: SyncOutboxItem['event']['type'],
  payload: SyncOutboxItem['event']['payload'],
  localSequence = 1,
): SyncOutboxItem {
  return {
    id,
    event: {
      id: `event-${id}`,
      type,
      deviceId: 'local-device',
      novelId: 'book_1',
      entityId: type === 'chapter_segments_updated' ? 'chapter_segments_chapter_1' : `${type}_book_1`,
      payload,
      createdAt: '2026-07-06T00:00:00.000Z',
    },
    status: 'failed',
    localSequence,
    attempts: 1,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  };
}

describe('AI/TTS sync diff previews', () => {
  it('compares local voice profile snapshots with remote snapshots', () => {
    const preview = buildAiTtsSyncSnapshotPreview({
      eventType: 'voice_profiles_updated',
      entityId: 'voice_profiles_book_1',
      novelId: 'book_1',
      items: [
        outboxItem('voice-local', 'voice_profiles_updated', {
          voiceProfiles: [
            {
              id: 'voice_1',
              label: 'Narrator',
              role: 'narrator',
              providerId: 'openai-tts',
              providerVoiceId: 'alloy',
              speed: 1.2,
              isUserSelected: true,
            },
            {
              id: 'voice_2',
              label: 'Hero',
              role: 'character',
              characterId: 'char_hero',
              providerId: 'elevenlabs',
              providerVoiceId: 'voice-hero',
              speed: 1,
              isUserSelected: true,
            },
          ],
        }),
      ],
      remoteSnapshot: {
        voiceProfiles: [
          {
            id: 'voice_1',
            label: 'Narrator',
            role: 'narrator',
            providerId: 'openai-tts',
            providerVoiceId: 'alloy',
            speed: 1,
            isUserSelected: true,
          },
          {
            id: 'voice_3',
            label: 'Old villain',
            role: 'character',
            characterId: 'char_villain',
            providerId: 'openai-tts',
            providerVoiceId: 'onyx',
            speed: 1,
            isUserSelected: false,
          },
        ],
      },
    });

    expect(preview).toMatchObject({
      eventType: 'voice_profiles_updated',
      localCount: 2,
      remoteCount: 2,
      addedCount: 1,
      removedCount: 1,
      changedCount: 1,
      unchangedCount: 0,
      hasRemoteSnapshot: true,
    });
    expect(preview.fieldDiffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'voice_1', field: 'speed', localValue: '1.2', remoteValue: '1' }),
        expect.objectContaining({ itemId: 'voice_2', field: 'item', changeType: 'added' }),
        expect.objectContaining({ itemId: 'voice_3', field: 'item', changeType: 'removed' }),
      ]),
    );
    expect(preview.summary).toContain('추가 1개');
    expect(preview.summary).toContain('변경 1개');
  });

  it('uses the latest replacement payload and includes graph relations', () => {
    const preview = buildAiTtsSyncSnapshotPreview({
      eventType: 'character_graph_updated',
      entityId: 'character_graph_book_1',
      novelId: 'book_1',
      items: [
        outboxItem(
          'graph-old',
          'character_graph_updated',
          {
            characters: [{ id: 'char_old', canonicalName: 'Old', aliases: [], confidence: 0.5 }],
          },
          1,
        ),
        outboxItem(
          'graph-new',
          'character_graph_updated',
          {
            characters: [
              { id: 'char_hero', canonicalName: 'Hero', aliases: ['H'], confidence: 0.9, isUserConfirmed: true },
              { id: 'char_friend', canonicalName: 'Friend', aliases: [], confidence: 0.7, isUserConfirmed: false },
            ],
            relations: [{ id: 'rel_1', sourceId: 'char_hero', targetId: 'char_friend', type: 'ally', confidence: 0.8 }],
          },
          2,
        ),
      ],
    });

    expect(preview).toMatchObject({
      localCount: 3,
      remoteCount: undefined,
      addedCount: 0,
      changedCount: 0,
      hasRemoteSnapshot: false,
    });
    expect(preview.summary).toContain('로컬 snapshot 3개');
    expect(preview.summary).toContain('서버 snapshot');
  });

  it('recognizes stored CharacterRelation fields in graph diffs', () => {
    const preview = buildAiTtsSyncSnapshotPreview({
      eventType: 'character_graph_updated',
      entityId: 'character_graph_book_1',
      novelId: 'book_1',
      items: [
        outboxItem('graph-local', 'character_graph_updated', {
          mode: 'replace',
          characters: [],
          relations: [
            {
              id: 'rel_1',
              novelId: 'book_1',
              sourceCharacterId: 'char_hero',
              targetCharacterId: 'char_friend',
              relationLabel: 'ally',
              termsUsedBySource: ['friend'],
              termsUsedByTarget: ['boss'],
              confidence: 0.8,
              evidence: ['chapter_1'],
            },
          ],
        }),
      ],
      remoteSnapshot: {
        characters: [],
        relations: [
          {
            id: 'rel_1',
            novelId: 'book_1',
            sourceCharacterId: 'char_hero',
            targetCharacterId: 'char_friend',
            relationLabel: 'rival',
            termsUsedBySource: ['friend'],
            termsUsedByTarget: ['boss'],
            confidence: 0.8,
            evidence: ['chapter_1'],
          },
        ],
      },
    });

    expect(preview.localCount).toBe(1);
    expect(preview.remoteCount).toBe(1);
    expect(preview.changedCount).toBe(1);
    expect(preview.fieldDiffs).toEqual([
      expect.objectContaining({
        itemId: 'relation:rel_1',
        field: 'relationLabel',
        localValue: 'ally',
        remoteValue: 'rival',
      }),
    ]);
  });

  it('treats multiple correction outbox rows as append candidates', () => {
    const preview = buildAiTtsSyncSnapshotPreview({
      eventType: 'user_correction_created',
      entityId: 'correction_batch',
      novelId: 'book_1',
      items: [
        outboxItem(
          'correction-1',
          'user_correction_created',
          {
            correction: {
              id: 'correction_1',
              novelId: 'book_1',
              chapterId: 'chapter_1',
              segmentId: 'segment_1',
              correctionType: 'speaker',
              afterJson: '{"speakerId":"char_hero"}',
              applyScope: 'chapter',
              createdAt: '2026-07-06T00:00:00.000Z',
            },
          },
          1,
        ),
        outboxItem(
          'correction-2',
          'user_correction_created',
          {
            correction: {
              id: 'correction_2',
              novelId: 'book_1',
              chapterId: 'chapter_1',
              segmentId: 'segment_2',
              correctionType: 'emotion',
              afterJson: '{"emotion":"tense"}',
              applyScope: 'future_pattern',
              createdAt: '2026-07-06T00:01:00.000Z',
            },
          },
          2,
        ),
      ],
      remoteSnapshot: {
        corrections: [],
      },
    });

    expect(preview.localCount).toBe(2);
    expect(preview.remoteCount).toBe(0);
    expect(preview.addedCount).toBe(2);
    expect(preview.fieldDiffs.map((diff) => diff.changeType)).toEqual(['added', 'added']);
  });

  it('shows correction deletion events as removing the remote correction', () => {
    const preview = buildAiTtsSyncSnapshotPreview({
      eventType: 'user_correction_deleted',
      entityId: 'correction_1',
      novelId: 'book_1',
      items: [
        outboxItem(
          'correction-delete',
          'user_correction_deleted',
          {
            id: 'correction_1',
            deletedAt: '2026-07-06T00:02:00.000Z',
          },
          1,
        ),
      ],
      remoteSnapshot: {
        corrections: [
          {
            id: 'correction_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            segmentId: 'segment_1',
            correctionType: 'speaker',
            afterJson: '{"speakerId":"char_hero"}',
            applyScope: 'chapter',
            createdAt: '2026-07-06T00:00:00.000Z',
          },
        ],
      },
    });

    expect(preview.localCount).toBe(0);
    expect(preview.remoteCount).toBe(1);
    expect(preview.removedCount).toBe(1);
    expect(preview.fieldDiffs).toEqual([expect.objectContaining({ itemId: 'correction_1', changeType: 'removed' })]);
  });
});

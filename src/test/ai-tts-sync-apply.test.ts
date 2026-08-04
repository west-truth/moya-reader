import { describe, expect, it } from 'vitest';
import { aggregateSyncEntityId } from '../domain/identity/sync-identities';
import { SYNC_CONTRACT_V2 } from '../sync/contract';
import {
  aiTtsFieldDiffKey,
  aiTtsRemoteSnapshotApplyAvailable,
  buildAiTtsMergedSnapshotFromSelections,
  buildAiTtsRemoteSnapshotApplyEvents,
} from '../sync/ai-tts-sync-apply';
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

describe('AI/TTS sync remote snapshot apply events', () => {
  it('keeps only selected local voice profile fields over the remote snapshot', () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'voice',
        'voice_profiles_updated',
        {
          voiceProfiles: [
            {
              id: 'voice_1',
              novelId: 'book_1',
              role: 'character',
              providerId: 'local-provider',
              providerVoiceId: 'local-voice',
              label: 'Local voice',
              speed: 1.1,
              isUserSelected: true,
            },
          ],
        },
        'voice_profiles_book_1',
      ),
    ]);

    const merged = buildAiTtsMergedSnapshotFromSelections(
      group!,
      {
        voiceProfiles: [
          {
            id: 'voice_1',
            novelId: 'book_1',
            role: 'character',
            providerId: 'remote-provider',
            providerVoiceId: 'remote-voice',
            label: 'Remote voice',
            speed: 0.9,
            isUserSelected: false,
          },
        ],
      },
      [aiTtsFieldDiffKey({ itemId: 'voice_1', field: 'providerVoiceId' })],
    );

    expect(merged.voiceProfiles).toEqual([
      expect.objectContaining({
        id: 'voice_1',
        providerId: 'remote-provider',
        providerVoiceId: 'local-voice',
        label: 'Remote voice',
      }),
    ]);
  });

  it('merges selected local Character Graph fields and additions over the remote snapshot', () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'graph',
        'character_graph_updated',
        {
          mode: 'replace',
          characters: [
            {
              id: 'char_1',
              novelId: 'book_1',
              canonicalName: 'Local Hero',
              aliases: ['Hero'],
              color: '#111111',
              confidence: 0.8,
              isUserConfirmed: true,
            },
            {
              id: 'char_2',
              novelId: 'book_1',
              canonicalName: 'Local Ally',
              aliases: ['Ally'],
              color: '#333333',
              confidence: 0.7,
              isUserConfirmed: false,
            },
          ],
          relations: [
            {
              id: 'rel_1',
              novelId: 'book_1',
              sourceCharacterId: 'char_1',
              targetCharacterId: 'char_2',
              relationLabel: 'friend',
              termsUsedBySource: [],
              termsUsedByTarget: [],
              confidence: 0.7,
              evidence: [],
            },
          ],
        },
        'character_graph_book_1',
      ),
    ]);

    const merged = buildAiTtsMergedSnapshotFromSelections(
      group!,
      {
        characters: [
          {
            id: 'char_1',
            novelId: 'book_1',
            canonicalName: 'Remote Hero',
            aliases: ['Remote'],
            color: '#222222',
            confidence: 0.95,
            isUserConfirmed: false,
          },
        ],
        relations: [
          {
            id: 'rel_1',
            novelId: 'book_1',
            sourceCharacterId: 'char_1',
            targetCharacterId: 'char_2',
            relationLabel: 'rival',
            termsUsedBySource: [],
            termsUsedByTarget: [],
            confidence: 0.5,
            evidence: [],
          },
        ],
      },
      [
        aiTtsFieldDiffKey({ itemId: 'character:char_1', field: 'canonicalName' }),
        aiTtsFieldDiffKey({ itemId: 'character:char_2', field: 'item' }),
        aiTtsFieldDiffKey({ itemId: 'relation:rel_1', field: 'relationLabel' }),
      ],
    );

    expect(merged.characters).toEqual([
      expect.objectContaining({ id: 'char_1', canonicalName: 'Local Hero', color: '#222222' }),
      expect.objectContaining({ id: 'char_2', canonicalName: 'Local Ally' }),
    ]);
    expect(merged.relations).toEqual([
      expect.objectContaining({ id: 'rel_1', relationLabel: 'friend', confidence: 0.5 }),
    ]);
  });

  it('can keep a local segment removal when that item diff is selected', () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'segments',
        'chapter_segments_updated',
        { chapterId: 'chapter_1', segments: [] },
        'chapter_segments_chapter_1',
      ),
    ]);

    const merged = buildAiTtsMergedSnapshotFromSelections(
      group!,
      {
        segments: [
          {
            id: 'segment_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            paragraphId: 'p1',
            segmentIndex: 0,
            startOffset: 0,
            endOffset: 4,
            segmentTextHash: 'hash',
            type: 'narration',
            speakerId: 'narrator',
            candidateSpeakers: ['narrator'],
            listenerIds: [],
            emotion: 'neutral',
            confidence: 0.8,
            isUserCorrected: false,
          },
        ],
      },
      [aiTtsFieldDiffKey({ itemId: 'segment_1', field: 'item' })],
    );

    expect(merged.segments).toEqual([]);
  });

  it('builds relation-inclusive graph replacement events from remote snapshots', () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'graph',
        'character_graph_updated',
        { mode: 'replace', characters: [], relations: [] },
        'character_graph_book_1',
      ),
    ]);

    const events = buildAiTtsRemoteSnapshotApplyEvents(
      group!,
      {
        characters: [
          {
            id: 'char_1',
            novelId: 'book_1',
            canonicalName: 'Hero',
            aliases: [],
            color: '#123456',
            confidence: 0.9,
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
            termsUsedBySource: [],
            termsUsedByTarget: [],
            confidence: 0.7,
            evidence: [],
          },
        ],
      },
      '2026-07-06T01:00:00.000Z',
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'character_graph_updated',
        ...SYNC_CONTRACT_V2,
        novelId: 'book_1',
        entityId: aggregateSyncEntityId({ entityType: 'character_graph', novelId: 'book_1' }),
        payload: {
          mode: 'replace',
          characters: [expect.objectContaining({ id: 'char_1' })],
          relations: [expect.objectContaining({ id: 'rel_1', relationLabel: 'mentor' })],
        },
      }),
    ]);
  });

  it('builds chapter segment replacement events with the group chapter id', () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'segments',
        'chapter_segments_updated',
        { chapterId: 'chapter_1', segments: [] },
        'chapter_segments_chapter_1',
      ),
    ]);

    const events = buildAiTtsRemoteSnapshotApplyEvents(
      group!,
      {
        segments: [
          {
            id: 'segment_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            paragraphId: 'p1',
            segmentIndex: 0,
            startOffset: 0,
            endOffset: 3,
            segmentTextHash: 'hash',
            type: 'quoted_dialogue',
            speakerId: 'char_1',
            candidateSpeakers: ['char_1'],
            listenerIds: [],
            emotion: 'neutral',
            confidence: 0.8,
            isUserCorrected: false,
          },
        ],
      },
      '2026-07-06T01:00:00.000Z',
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'chapter_segments_updated',
        ...SYNC_CONTRACT_V2,
        entityId: aggregateSyncEntityId({
          entityType: 'chapter_segments',
          novelId: 'book_1',
          chapterId: 'chapter_1',
        }),
        payload: {
          chapterId: 'chapter_1',
          segments: [expect.objectContaining({ id: 'segment_1', speakerId: 'char_1' })],
        },
      }),
    ]);
  });

  it('does not expose remote snapshot apply for append-only correction groups', () => {
    const [group] = summarizeAiTtsSyncConflictGroups([
      outboxItem(
        'correction',
        'user_correction_created',
        {
          correction: {
            id: 'correction_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            correctionType: 'speaker',
            afterJson: '{}',
            applyScope: 'chapter',
            createdAt: '2026-07-06T00:00:00.000Z',
          },
        },
        'correction_1',
      ),
    ]);

    expect(aiTtsRemoteSnapshotApplyAvailable(group!)).toBe(false);
    expect(() => buildAiTtsRemoteSnapshotApplyEvents(group!, {}, '2026-07-06T01:00:00.000Z')).toThrow(/not supported/);
  });
});

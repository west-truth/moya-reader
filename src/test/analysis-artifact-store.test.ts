import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import {
  chapterSegmentsRevision,
  correctionRevision,
  ResourceRevisionConflictError,
  voiceProfilesRevision,
} from '../domain/resource-revisions';
import type { Character, LabeledSegment, VoiceProfile } from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import * as artifactStore from '../storage/analysis-artifact-store';
import * as readerDb from '../storage/db';

describe('analysis artifact store', () => {
  beforeEach(async () => {
    await readerDb.resetReaderDbForTests();
  });

  it('keeps the db compatibility facade bound to the analysis artifact module', () => {
    expect(readerDb.saveSegments).toBe(artifactStore.saveSegments);
    expect(readerDb.saveCharacterGraph).toBe(artifactStore.saveCharacterGraph);
    expect(readerDb.saveVoiceProfiles).toBe(artifactStore.saveVoiceProfiles);
    expect(readerDb.deleteCorrection).toBe(artifactStore.deleteCorrection);
  });

  it('replaces indexed artifacts without full-store reads and preserves ordering', async () => {
    const segment: LabeledSegment = {
      id: 'artifact-segment-2',
      novelId: 'artifact-book',
      chapterId: 'artifact-chapter',
      paragraphId: 'artifact-paragraph',
      segmentIndex: 2,
      startOffset: 5,
      endOffset: 10,
      segmentTextHash: integrityHash('artifact:segment:2'),
      type: 'quoted_dialogue',
      speakerId: 'artifact-character',
      candidateSpeakers: ['artifact-character'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.9,
      isUserCorrected: false,
    };
    const character: Character = {
      id: 'artifact-character',
      novelId: 'artifact-book',
      canonicalName: 'Character',
      aliases: [],
      color: '#123456',
      confidence: 0.8,
      isUserConfirmed: false,
    };

    await artifactStore.saveSegments('artifact-chapter', [
      segment,
      { ...segment, id: 'artifact-segment-1', segmentIndex: 1 },
    ]);
    await artifactStore.saveCharacters('artifact-book', [character]);

    expect((await artifactStore.getSegments('artifact-chapter')).map((item) => item.id)).toEqual([
      'artifact-segment-1',
      'artifact-segment-2',
    ]);
    expect(await artifactStore.getCharacters('artifact-book')).toEqual([character]);

    await artifactStore.saveSegments('artifact-chapter', []);
    await artifactStore.saveCharacters('artifact-book', []);
    expect(await artifactStore.getSegments('artifact-chapter')).toEqual([]);
    expect(await artifactStore.getCharacters('artifact-book')).toEqual([]);
  });

  it('rejects stale aggregate replacements without changing data or the sync outbox', async () => {
    const segment: LabeledSegment = {
      id: 'revision-segment',
      novelId: 'revision-book',
      chapterId: 'revision-chapter',
      paragraphId: 'revision-paragraph',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: 8,
      segmentTextHash: integrityHash('revision-segment'),
      type: 'quoted_dialogue',
      speakerId: 'revision-character',
      candidateSpeakers: ['revision-character'],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.8,
      isUserCorrected: false,
    };
    const absentRevision = chapterSegmentsRevision([]);

    await artifactStore.saveSegments(segment.chapterId, [segment], { expectedRevision: absentRevision });
    const initialRevision = chapterSegmentsRevision([segment]);
    const updated = { ...segment, emotion: 'tense' as const, confidence: 0.95 };
    await artifactStore.saveSegments(segment.chapterId, [updated], { expectedRevision: initialRevision });
    const outboxAfterUpdate = await readerDb.listSyncOutbox();

    await expect(
      artifactStore.saveSegments(segment.chapterId, [{ ...segment, emotion: 'sad' }], {
        expectedRevision: initialRevision,
      }),
    ).rejects.toBeInstanceOf(ResourceRevisionConflictError);

    expect(await artifactStore.getSegments(segment.chapterId)).toEqual([updated]);
    expect(await readerDb.listSyncOutbox()).toEqual(outboxAfterUpdate);
  });

  it('uses semantic JSON values for correction revisions', () => {
    const correction = {
      id: 'revision-correction',
      novelId: 'revision-book',
      chapterId: 'revision-chapter',
      correctionType: 'speaker' as const,
      beforeJson: '{"speakerId":"unknown","confidence":0.5}',
      afterJson: '{"speakerId":"character-1","confidence":1}',
      applyScope: 'chapter' as const,
      createdAt: '2026-07-10T01:00:00.000Z',
    };

    expect(correctionRevision(correction)).toBe(
      correctionRevision({
        ...correction,
        beforeJson: '{"confidence":0.5,"speakerId":"unknown"}',
        afterJson: '{"confidence":1,"speakerId":"character-1"}',
      }),
    );
  });

  it('rejects secret-like voice options before persistence or sync event creation', async () => {
    const profile: VoiceProfile = {
      id: 'artifact-voice',
      novelId: 'artifact-book',
      role: 'character',
      providerId: 'elevenlabs',
      providerVoiceId: 'voice-1',
      label: 'Voice',
      speed: 1,
      isUserSelected: true,
    };

    await expect(
      artifactStore.saveVoiceProfiles('artifact-book', [
        { ...profile, providerOptions: { apiKey: 'sk-secret-value' } },
      ]),
    ).rejects.toThrow('must not contain secret-like');
    expect(await artifactStore.getVoiceProfiles('artifact-book')).toEqual([]);
    expect(await readerDb.listSyncOutbox()).toEqual([]);

    const optimisticProfiles: VoiceProfile[] = [
      { ...profile, id: 'voice-character', label: 'B' },
      { ...profile, id: 'voice-narrator', role: 'narrator', label: 'A' },
    ];
    await artifactStore.saveVoiceProfiles('artifact-book', optimisticProfiles);
    expect((await artifactStore.getVoiceProfiles('artifact-book')).map((item) => item.id)).toEqual([
      'voice-narrator',
      'voice-character',
    ]);
    await artifactStore.saveVoiceProfiles(
      'artifact-book',
      optimisticProfiles.map((item) => (item.id === 'voice-character' ? { ...item, speed: 1.1 } : item)),
      { expectedRevision: voiceProfilesRevision(optimisticProfiles) },
    );
    expect((await readerDb.listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'voice_profiles_updated',
      'voice_profiles_updated',
    ]);
  });

  it('preserves relations when replacing characters and reserves explicit relations for full graph replacement', async () => {
    const characters: Character[] = [
      {
        id: 'artifact-character-a',
        novelId: 'artifact-book',
        canonicalName: 'Character A',
        aliases: [],
        color: '#123456',
        confidence: 0.8,
        isUserConfirmed: false,
      },
      {
        id: 'artifact-character-b',
        novelId: 'artifact-book',
        canonicalName: 'Character B',
        aliases: [],
        color: '#654321',
        confidence: 0.7,
        isUserConfirmed: false,
      },
      {
        id: 'artifact-character-c',
        novelId: 'artifact-book',
        canonicalName: 'Character C',
        aliases: [],
        color: '#abcdef',
        confidence: 0.6,
        isUserConfirmed: false,
      },
    ];
    const relation: CharacterRelation = {
      id: 'artifact-relation',
      novelId: 'artifact-book',
      sourceCharacterId: 'artifact-character-a',
      targetCharacterId: 'artifact-character-b',
      relationLabel: 'ally',
      termsUsedBySource: [],
      termsUsedByTarget: [],
      confidence: 0.9,
    };
    const removedRelation: CharacterRelation = {
      ...relation,
      id: 'artifact-removed-relation',
      targetCharacterId: 'artifact-character-c',
    };

    await artifactStore.saveCharacterGraph('artifact-book', { characters, relations: [relation, removedRelation] });
    await artifactStore.saveCharacters('artifact-book', [
      { ...characters[0]!, canonicalName: 'Updated A' },
      characters[1]!,
    ]);

    expect(await artifactStore.getCharacterRelations('artifact-book')).toEqual([relation]);
    const characterOnlyEvent = (await readerDb.listSyncOutbox()).at(-1)?.event;
    expect(characterOnlyEvent?.payload).toMatchObject({
      mode: 'replace',
      characters: [
        expect.objectContaining({ canonicalName: 'Updated A' }),
        expect.objectContaining({ id: characters[1]!.id }),
      ],
    });
    expect(characterOnlyEvent?.payload).not.toHaveProperty('relations');

    await artifactStore.saveCharacterGraph('artifact-book', { characters, relations: [] });
    expect(await artifactStore.getCharacterRelations('artifact-book')).toEqual([]);
    expect((await readerDb.listSyncOutbox()).at(-1)?.event.payload).toMatchObject({ relations: [] });
  });

  it('rolls back artifact replacements when their sync event cannot be queued', async () => {
    const segment: LabeledSegment = {
      id: 'rollback-segment',
      novelId: 'rollback-segment-book',
      chapterId: 'rollback-chapter',
      paragraphId: 'rollback-paragraph',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: 4,
      segmentTextHash: integrityHash('rollback-segment'),
      type: 'narration',
      speakerId: 'narrator',
      candidateSpeakers: [],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.9,
      isUserCorrected: false,
    };
    const character: Character = {
      id: 'rollback-character',
      novelId: 'rollback-character-book',
      canonicalName: 'Original Character',
      aliases: [],
      color: '#123456',
      confidence: 0.8,
      isUserConfirmed: false,
    };
    const voiceProfile: VoiceProfile = {
      id: 'rollback-voice',
      novelId: 'rollback-voice-book',
      role: 'narrator',
      providerId: 'system',
      providerVoiceId: 'default',
      label: 'Original Voice',
      speed: 1,
      isUserSelected: true,
    };

    await artifactStore.saveSegments(segment.chapterId, [segment]);
    await artifactStore.saveCharacters(character.novelId, [character]);
    await artifactStore.saveVoiceProfiles(voiceProfile.novelId, [voiceProfile]);
    const outboxBeforeFailures = await readerDb.listSyncOutbox();

    await expect(
      artifactStore.saveSegments(segment.chapterId, [
        { ...segment, id: 'invalid-segment', segmentTextHash: 'invalid' },
      ]),
    ).rejects.toThrow('segmentTextHash');
    await expect(
      artifactStore.saveCharacters(character.novelId, [
        { ...character, canonicalName: 'Invalid Character', segmentTextHash: 'invalid' } as Character,
      ]),
    ).rejects.toThrow('segmentTextHash');
    await expect(
      artifactStore.saveVoiceProfiles(voiceProfile.novelId, [
        { ...voiceProfile, label: 'Invalid Voice', segmentTextHash: 'invalid' } as VoiceProfile,
      ]),
    ).rejects.toThrow('segmentTextHash');

    expect(await artifactStore.getSegments(segment.chapterId)).toEqual([segment]);
    expect(await artifactStore.getCharacters(character.novelId)).toEqual([character]);
    expect(await artifactStore.getVoiceProfiles(voiceProfile.novelId)).toEqual([
      expect.objectContaining({ id: voiceProfile.id, label: voiceProfile.label }),
    ]);
    expect(await readerDb.listSyncOutbox()).toEqual(outboxBeforeFailures);
  });

  it('rejects synchronous IndexedDB write errors instead of leaving the save pending', async () => {
    const character: Character = {
      id: 'clone-error-character',
      novelId: 'clone-error-book',
      canonicalName: 'Clone Error',
      aliases: [],
      color: '#123456',
      confidence: 0.8,
      isUserConfirmed: false,
    };
    await artifactStore.saveCharacters(character.novelId, [character]);
    const outboxBeforeFailure = await readerDb.listSyncOutbox();
    const invalidCharacter = {
      ...character,
      aliases: [() => undefined],
    } as unknown as Character;

    await expect(
      Promise.race([
        artifactStore.saveCharacters(character.novelId, [invalidCharacter]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('save remained pending')), 250)),
      ]),
    ).rejects.toMatchObject({ name: 'DataCloneError' });

    expect(await artifactStore.getCharacters(character.novelId)).toEqual([character]);
    expect(await readerDb.listSyncOutbox()).toEqual(outboxBeforeFailure);
  });
});

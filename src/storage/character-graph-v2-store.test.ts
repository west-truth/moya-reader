import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import { characterGraphRevision } from '../domain/resource-revisions';
import type { Character, LabeledSegment, ParsedNovel, VoiceProfile } from '../domain/types';
import { applyLocalCharacterIdentityCommandV2, getCharacterGraphKnowledgeV2 } from './character-graph-v2-store';
import { getCharacters, getSegments, getVoiceProfiles, saveImportedNovel } from './db';
import { openReaderDb, resetReaderDbForTests } from './reader-database';

const now = '2026-07-11T00:00:00.000Z';
const source: Character = {
  id: 'character-source',
  novelId: 'book-1',
  canonicalName: '서윤 후보',
  aliases: ['서윤', '그녀'],
  color: '#111111',
  confidence: 0.7,
  isUserConfirmed: false,
};
const target: Character = {
  id: 'character-target',
  novelId: 'book-1',
  canonicalName: '한서윤',
  aliases: ['팀장님'],
  color: '#222222',
  confidence: 1,
  isUserConfirmed: true,
};

function fixture(): ParsedNovel {
  return {
    novel: {
      id: 'book-1',
      title: 'Book',
      sourceFileName: 'book.txt',
      sourceEncoding: 'utf-8',
      rawText: '안녕',
      normalizedText: '안녕',
      rawTextHash: 'raw-hash',
      normalizedTextHash: 'normalized-hash',
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters: 2,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: 'chapter-1',
        novelId: 'book-1',
        index: 1,
        title: 'Chapter',
        normalizedText: '안녕',
        textHash: 'chapter-hash',
        rawStartOffset: 0,
        rawEndOffset: 2,
        characterCount: 2,
        paragraphCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs: [
      {
        id: 'paragraph-1',
        novelId: 'book-1',
        chapterId: 'chapter-1',
        index: 1,
        text: '안녕',
        startOffsetInChapter: 0,
        endOffsetInChapter: 2,
        textHash: 'paragraph-hash',
      },
    ],
  };
}

async function seedGraph(): Promise<void> {
  const segment: LabeledSegment = {
    id: 'segment-1',
    novelId: 'book-1',
    chapterId: 'chapter-1',
    paragraphId: 'paragraph-1',
    segmentIndex: 0,
    startOffset: 0,
    endOffset: 2,
    segmentTextHash: integrityHash('안녕'),
    type: 'quoted_dialogue',
    speakerId: source.id,
    candidateSpeakers: [source.id],
    listenerIds: [target.id],
    emotion: 'neutral',
    confidence: 0.7,
    voiceProfileId: 'voice-source',
    isUserCorrected: false,
  };
  const voiceProfiles: VoiceProfile[] = [
    {
      id: 'voice-source',
      novelId: 'book-1',
      characterId: source.id,
      role: 'character',
      providerId: 'openai-tts',
      providerVoiceId: 'source',
      label: 'Source',
      speed: 1,
      isUserSelected: true,
    },
    {
      id: 'voice-target',
      novelId: 'book-1',
      characterId: target.id,
      role: 'character',
      providerId: 'openai-tts',
      providerVoiceId: 'target',
      label: 'Target',
      speed: 1,
      isUserSelected: true,
    },
  ];
  const db = await openReaderDb();
  const tx = db.transaction(['characters', 'segments', 'voice_profiles'], 'readwrite');
  tx.objectStore('characters').put(source);
  tx.objectStore('characters').put(target);
  tx.objectStore('segments').put(segment);
  voiceProfiles.forEach((profile) => tx.objectStore('voice_profiles').put(profile));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

describe('Character Graph v2 IndexedDB store', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
    await saveImportedNovel(fixture());
    await seedGraph();
  });

  it('lazy-backfills legacy graph data and atomically replays a merge receipt', async () => {
    const knowledge = await getCharacterGraphKnowledgeV2('book-1');
    expect(knowledge.mentions).toEqual([expect.objectContaining({ surface: '그녀' })]);
    const command = {
      kind: 'merge_characters_v2' as const,
      operationId: 'identity-operation-1',
      novelId: 'book-1',
      sourceCharacterId: source.id,
      targetCharacterId: target.id,
      expectedGraphRevision: characterGraphRevision([source, target], []),
      selectedFactIds: knowledge.facts.filter((fact) => fact.characterId === source.id).map((fact) => fact.id),
      voiceConflictPolicy: 'require_review' as const,
      createdAt: now,
    };

    const result = await applyLocalCharacterIdentityCommandV2(command);
    const replay = await applyLocalCharacterIdentityCommandV2(command);

    expect(replay).toEqual(result);
    expect(await getCharacters('book-1')).toEqual([
      expect.objectContaining({ id: target.id, canonicalName: target.canonicalName, isUserConfirmed: true }),
    ]);
    expect(await getSegments('chapter-1')).toEqual([
      expect.objectContaining({ speakerId: target.id, voiceProfileId: undefined }),
    ]);
    expect(await getVoiceProfiles('book-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'voice-source', characterId: undefined }),
        expect.objectContaining({ id: 'voice-target', characterId: target.id }),
      ]),
    );
    expect((await getCharacterGraphKnowledgeV2('book-1')).redirects).toEqual([
      expect.objectContaining({ sourceCharacterId: source.id, targetCharacterId: target.id }),
    ]);
    expect(result.affectedChapterIndexes).toEqual([1]);
  });
});

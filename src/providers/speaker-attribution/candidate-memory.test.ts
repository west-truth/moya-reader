import { describe, expect, it } from 'vitest';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import {
  buildSpeakerSceneInventory,
  buildSpeakerSpanInventory,
  type SpeakerSourceParagraphInput,
} from '@noveldesk/text-core/speaker-attribution';
import type { Character } from '../../domain/types';
import { backfillCharacterGraphKnowledgeV2 } from '../character-graph-v2';
import { buildAddressUseEvents } from './address-event';
import { buildCandidateMemoryView } from './candidate-memory';
import { selectSpeakerCandidates } from './candidate-selector';
import { runDeterministicSpeakerSieve } from './deterministic-sieve';
import { buildSpeakerAttributionChapter } from './inventory-builder';
import {
  coalesceSourceSpeakerEntitiesForMemory,
  deriveSourceSpeakerEntities,
  type SpeakerEntityV1,
} from './identity-policy';
import { buildSourceMentionInventory } from './mention-inventory';

function sourceParagraphs(texts: readonly string[]): SpeakerSourceParagraphInput[] {
  let offset = 0;
  return texts.map((text, paragraphIndex) => {
    const startOffsetInChapter = offset;
    offset += text.length + 2;
    return {
      paragraphId: `paragraph_${paragraphIndex}`,
      chapterId: 'chapter_1',
      paragraphIndex,
      text,
      textHash: textIntegrityHash(text),
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
    };
  });
}

function character(id: string, canonicalName: string, aliases: readonly string[] = []): Character {
  return {
    id,
    novelId: 'book_1',
    canonicalName,
    aliases: [...aliases],
    color: '#336699',
    confidence: 0.9,
    isUserConfirmed: false,
  };
}

describe('source mentions and Candidate Memory', () => {
  it('shows the observed address together with reader-time-valid identity facts', () => {
    const representative = character('character_huyoung', '유후영', ['대표님']);
    const paragraphs = sourceParagraphs(['대표님: 준비됐습니까?']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [representative],
      relations: [],
    });
    const mentionInventory = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [representative],
      graphKnowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [representative],
      graphKnowledge,
      mentionInventory,
      sourceEntities: [],
      addressEvents: [],
    });

    expect(memory.entities[0]?.displayName).toContain('대표님');
    expect(memory.entities[0]?.displayName).toContain('유후영');
  });

  it('does not bind a shared title alias and keeps a new name-title candidate scene-local', () => {
    const first = character('character_first', '유후영', ['대표님']);
    const second = character('character_second', '장아린', ['대표님']);
    const paragraphs = sourceParagraphs([
      '대표님이 말했다.',
      '법무 팀 최종수 팀장이 들어왔다. 회의에 팀장도 참석했다.',
      '“검토하겠습니다.”',
    ]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [first, second],
      relations: [],
    });
    const mentionInventory = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [first, second],
      graphKnowledge,
    });
    const sharedTitleMentions = mentionInventory.mentions.filter((mention) => mention.normalizedSurface === '대표님');
    expect(sharedTitleMentions.length).toBeGreaterThan(0);
    expect(sharedTitleMentions.every((mention) => mention.characterId === undefined)).toBe(true);
    const newTitleMention = mentionInventory.mentions.find((mention) => mention.normalizedSurface === '최종수 팀장');
    expect(newTitleMention).toMatchObject({ type: 'title_name', characterId: undefined });
    expect(mentionInventory.mentions.some((mention) => mention.normalizedSurface === '회의에 팀장')).toBe(false);

    const sceneOrdinalById = Object.fromEntries(scenes.scenes.map((scene) => [scene.id, scene.sceneIndex]));
    const sourceEntities = deriveSourceSpeakerEntities({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      mentions: mentionInventory.mentions,
      sceneOrdinalById,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [first, second],
      graphKnowledge,
      mentionInventory,
      sourceEntities,
      addressEvents: [],
    });
    const dialogueSpan = spans.spans.find((span) => span.paragraphId === 'paragraph_2')!;
    const decision = selectSpeakerCandidates({ targetSpan: dialogueSpan, memory, mentionInventory });
    const newTitleEntity = memory.entities.find((entity) => entity.displayName === '최종수 팀장');
    expect(newTitleEntity).toBeDefined();
    expect(decision.selectedEntityIds).toContain(newTitleEntity!.entityId);
  });

  it('keeps unrelated full-graph characters out of a scene-local Candidate Memory view', () => {
    const local = character('character_local', 'Local Speaker');
    const unrelated = Array.from({ length: 30 }, (_, index) =>
      character(`character_unrelated_${index}`, `Unrelated ${index}`),
    );
    const characters = [local, ...unrelated];
    const paragraphs = sourceParagraphs(['Local Speaker: 준비됐어?']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters, relations: [] });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters,
      graphKnowledge: knowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters,
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
    });
    const decision = selectSpeakerCandidates({
      targetSpan: spans.spans[0]!,
      memory,
      mentionInventory: mentions,
    });

    expect(memory.version).toBe('candidate-memory-view-v6');
    expect(memory.entities.map((entity) => entity.characterId)).toEqual([local.id]);
    expect(memory.entities[0]?.inclusionReasons).toContain('explicit_message_sender');
    expect(decision.selectedEntityIds).toEqual([memory.entities[0]!.entityId]);
    expect(decision.evidence[0]?.softReasons).not.toContain('scene_active');
  });

  it('keeps recent accepted speakers available without restoring global graph candidates', () => {
    const recent = character('character_recent', 'Recent Speaker');
    const unrelated = character('character_unrelated', 'Unrelated Speaker');
    const characters = [recent, unrelated];
    const paragraphs = sourceParagraphs(['“이름이 없는 대화.”']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters, relations: [] });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters,
      graphKnowledge: knowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters,
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
      recentTurns: [
        {
          paragraphId: 'previous_paragraph',
          speakerId: recent.id,
          listenerIds: [],
          emotion: 'neutral',
          text: 'previous turn',
        },
      ],
    });

    expect(memory.entities.map((entity) => entity.characterId)).toEqual([recent.id]);
    expect(memory.entities[0]?.inclusionReasons).toContain('recent_accepted_speaker');
  });

  it('scores a repeated evidence reason once per candidate', () => {
    const recent = character('character_recent', '김민준');
    const paragraphs = sourceParagraphs(['“계속하죠.”']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_deduplicated_score',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_deduplicated_score',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [recent],
      relations: [],
    });
    const mentionInventory = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_deduplicated_score',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [recent],
      graphKnowledge,
    });
    const repeatedTurn = {
      paragraphId: 'previous_paragraph',
      speakerId: recent.id,
      listenerIds: [],
      emotion: 'neutral' as const,
      text: 'previous turn',
    };
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_deduplicated_score',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [recent],
      graphKnowledge,
      mentionInventory,
      sourceEntities: [],
      addressEvents: [],
      recentTurns: [repeatedTurn, repeatedTurn, repeatedTurn],
    });

    const decision = selectSpeakerCandidates({
      targetSpan: spans.spans[0]!,
      memory,
      mentionInventory,
    });

    expect(decision.evidence[0]?.softReasons).toEqual(['recent_turn']);
    expect(decision.evidence[0]?.score).toBe(18);
  });

  it('prefers the longest overlapping known character surface', () => {
    const short = character('character_short', '민준');
    const long = character('character_long', '김민준');
    const characters = [short, long];
    const paragraphs = sourceParagraphs(['김민준이 말했다.']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters,
    });

    expect(mentions.mentions.filter((mention) => mention.characterId === short.id)).toEqual([]);
    expect(mentions.mentions).toEqual(
      expect.arrayContaining([expect.objectContaining({ normalizedSurface: '김민준', characterId: long.id })]),
    );
  });

  it('does not resolve a character surface before its reader-time-valid chapter', () => {
    const future = character('character_future', '미래인물');
    const paragraphs = sourceParagraphs(['미래인물이 고개를 끄덕였다.']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [future],
      relations: [],
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
      spanInventory: spans,
      characters: [future],
      graphKnowledge: {
        ...knowledge,
        facts: knowledge.facts.map((fact) => ({ ...fact, validity: { fromChapterIndex: 5 } })),
      },
    });

    expect(mentions.mentions.some((mention) => mention.characterId === future.id)).toBe(false);
  });

  it('keeps address observations unresolved and requires independent evidence for provisional promotion', () => {
    const paragraphs = sourceParagraphs([
      'Alex: 준비됐어?',
      '민준이 말했다.',
      '민준은 다시 물었다.',
      '“선배, 기다려요.”',
      '서윤이 속삭였다.',
    ]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const alex = character('character_alex', 'Alex');
    const knowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters: [alex], relations: [] });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [alex],
      graphKnowledge: knowledge,
    });
    const sceneOrdinalById = Object.fromEntries(scenes.scenes.map((scene) => [scene.id, scene.sceneIndex]));
    const sourceEntities = deriveSourceSpeakerEntities({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      mentions: mentions.mentions,
      sceneOrdinalById,
    });
    const addressEvents = buildAddressUseEvents({ mentionInventory: mentions });

    expect(mentions.mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedSurface: 'alex', characterId: 'character_alex' }),
        expect.objectContaining({ normalizedSurface: '선배', type: 'address_term' }),
      ]),
    );
    const minjun = sourceEntities.find((entity) => entity.displayName === '민준');
    const seoyun = sourceEntities.find((entity) => entity.displayName === '서윤');
    expect(minjun).toMatchObject({ entityKind: 'provisional', promotionEligible: true, status: 'active' });
    expect(seoyun).toMatchObject({ entityKind: 'provisional', promotionEligible: false, status: 'ambiguous' });
    expect(sourceEntities.some((entity) => entity.displayName === '선배')).toBe(false);
    expect(addressEvents).toEqual([
      expect.objectContaining({
        normalizedSurface: '선배',
        relationStatus: 'unresolved',
        status: 'observed',
        speakerCandidateIds: [],
        addresseeCandidateIds: [],
      }),
    ]);

    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [alex],
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities,
      addressEvents,
    });
    const alexSpan = spans.spans.find((span) => span.paragraphId === 'paragraph_0')!;
    const decision = selectSpeakerCandidates({ targetSpan: alexSpan, memory, mentionInventory: mentions });
    const alexEntity = memory.entities.find((entity) => entity.characterId === 'character_alex')!;
    expect(decision.hardIncludeEntityIds).toContain(alexEntity.entityId);
    expect(decision.selectedEntityIds).toContain(alexEntity.entityId);

    const seoyunSpan = spans.spans.find((span) => span.paragraphId === 'paragraph_4')!;
    expect(
      selectSpeakerCandidates({ targetSpan: seoyunSpan, memory, mentionInventory: mentions }).newFromMentionOrdinals,
    ).toHaveLength(1);
  });

  it('treats names inside ordinary text as soft candidates instead of hard speaker evidence', () => {
    const characters = Array.from({ length: 25 }, (_, index) => character(`character_${index}`, `Name${index}`));
    const text = characters.map((item) => item.canonicalName).join(' ');
    const paragraphs = sourceParagraphs([text]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters, relations: [] });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters,
      graphKnowledge: knowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters,
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
    });
    const decision = selectSpeakerCandidates({
      targetSpan: spans.spans[0]!,
      memory,
      mentionInventory: mentions,
      maxCandidates: 16,
      hardCap: 24,
    });

    expect(decision.hardIncludeEntityIds).toEqual([]);
    expect(decision.requiresWindowSplit).toBe(false);
    expect(decision.selectedEntityIds).toHaveLength(16);
    expect(decision.trimmedEntityIds).toHaveLength(9);
  });

  it('excludes a character first mentioned after the target but allows an adjacent speech attribution', () => {
    const visitor = character('character_visitor', '최종수', ['최종수 팀장']);
    const paragraphs = sourceParagraphs([
      '“가족이 아니라 본인에게만 알리겠습니다.”',
      '“대표님, 최종수 팀장님 오셨습니다.”',
      '최종수 팀장이 들어왔다.',
    ]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [visitor],
      relations: [],
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [visitor],
      graphKnowledge: knowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [visitor],
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
    });
    const firstDialogue = spans.spans.find((span) => span.paragraphId === 'paragraph_0')!;
    expect(
      selectSpeakerCandidates({ targetSpan: firstDialogue, memory, mentionInventory: mentions }).selectedEntityIds,
    ).toEqual([]);

    const attributedParagraphs = sourceParagraphs(['“준비됐습니까?”', '최종수가 말했다.']);
    const attributedScenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_2',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs: attributedParagraphs,
    });
    const attributedSpans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_2',
      chapterId: 'chapter_1',
      paragraphs: attributedParagraphs,
      sceneInventory: attributedScenes,
    });
    const attributedMentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_2',
      chapterId: 'chapter_1',
      paragraphs: attributedParagraphs,
      spanInventory: attributedSpans,
      characters: [visitor],
      graphKnowledge: knowledge,
    });
    const attributedMemory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_2',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: attributedScenes.scenes[0]!.id,
      characters: [visitor],
      graphKnowledge: knowledge,
      mentionInventory: attributedMentions,
      sourceEntities: [],
      addressEvents: [],
    });
    const attributedDialogue = attributedSpans.spans.find((span) => span.paragraphId === 'paragraph_0')!;
    const attributedDecision = selectSpeakerCandidates({
      targetSpan: attributedDialogue,
      memory: attributedMemory,
      mentionInventory: attributedMentions,
    });
    expect(attributedDecision.selectedEntityIds).toEqual([attributedMemory.entities[0]!.entityId]);
    expect(attributedDecision.evidence[0]?.hardReasons).toContain('adjacent_speech_attribution');
  });

  it('leaves adjacent action semantics to the model instead of scoring the named subject in code', () => {
    const speaker = character('character_speaker', '김민준');
    const paragraphs = sourceParagraphs(['“받으세요.”', '김민준이 계약서를 받아 들었다.']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_action_subject',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_action_subject',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [speaker],
      relations: [],
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_action_subject',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [speaker],
      graphKnowledge: knowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_action_subject',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [speaker],
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
    });
    const dialogue = spans.spans.find((span) => span.paragraphId === 'paragraph_0')!;
    const decision = selectSpeakerCandidates({ targetSpan: dialogue, memory, mentionInventory: mentions });

    expect(decision.evidence).toEqual([]);
    expect(decision.candidateSufficiency).toBe('insufficient');
  });

  it('routes a structurally insufficient candidate set to review before provider dispatch', () => {
    const paragraphs = sourceParagraphs(['“누가 말했는지 알 수 없다.”']);
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters: [], relations: [] });
    const build = buildSpeakerAttributionChapter({
      bookId: 'book_1',
      contentRevisionId: 'revision_candidate_insufficient',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
      characters: [],
      graphKnowledge,
    });
    const target = build.inventory.spanInventory.spans.find((span) => span.voiceBearing)!;
    const selection = build.candidateSelections[target.id]!;
    const sieve = runDeterministicSpeakerSieve({
      spanInventory: build.inventory.spanInventory,
      paragraphs,
      mentionInventory: build.inventory.mentionInventory,
      candidateSelections: build.candidateSelections,
      candidateMemories: build.candidateMemories,
    });

    expect(selection.candidateSufficiency).toBe('insufficient');
    expect(selection.sufficiencyReasonCodes).toEqual(['no_grounded_candidate']);
    expect(sieve.decisions.find((decision) => decision.spanId === target.id)).toMatchObject({
      outcome: 'boundary_review',
      ruleCode: 'candidate_insufficient',
    });
    expect(sieve.providerTargetSpanIds).not.toContain(target.id);
  });

  it('recovers a distant same-scene character as a bounded source candidate without interpreting the action', () => {
    const assistant = character('character_assistant', '김도윤', ['도윤', '도윤 씨']);
    const boss = character('character_boss', '박지훈', ['사장', '사장님']);
    const paragraphs = sourceParagraphs([
      '김도윤이 사장실에서 물잔을 나누어 주었다.',
      '“도윤 씨. 회의실에 남은 사람을 한 명 불러 주세요.”',
      '박지훈이 도윤에게 말했다.',
      ...Array.from({ length: 13 }, (_, index) => `회의 자료를 검토하는 서술 ${index}`),
      '“사장님, 정하늘 팀장님 회의 준비가 끝났습니다.”',
      '회의실 문이 열렸다.',
    ]);
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [assistant, boss],
      relations: [],
    });
    const build = buildSpeakerAttributionChapter({
      bookId: 'book_1',
      contentRevisionId: 'revision_no_lexical_state',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
      characters: [assistant, boss],
      graphKnowledge,
    });
    const target = build.inventory.spanInventory.spans.find((span) => span.paragraphId === 'paragraph_16')!;
    const decision = build.candidateSelections[target.id]!;
    const assistantEntity = build.candidateMemories[target.sceneId]!.entities.find(
      (entity) => entity.characterId === assistant.id,
    )!;
    const evidence = decision.evidence.find((item) => item.entityId === assistantEntity.entityId);

    expect(target.spanIndex).toBeGreaterThan(12);
    expect(evidence?.softReasons).toContain('distant_scene_mention');
    expect(evidence?.supportingSourceMentionIds).toHaveLength(1);
    expect(decision.selectedEntityIds).toContain(assistantEntity.entityId);
    expect(decision.supportingSourceMentionIds).toEqual(evidence?.supportingSourceMentionIds);
  });

  it('does not expand distant scene candidates for an ordinary target without a structural ambiguity signal', () => {
    const distant = character('character_distant', '김민준');
    const paragraphs = sourceParagraphs([
      '김민준이 방을 나갔다.',
      ...Array.from({ length: 13 }, (_, index) => `중간 서술 ${index}`),
      '“계속 진행하죠.”',
    ]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_local_window',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_local_window',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const knowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [distant],
      relations: [],
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_local_window',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [distant],
      graphKnowledge: knowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_local_window',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters: [distant],
      graphKnowledge: knowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
    });
    const target = spans.spans.find((span) => span.paragraphId === 'paragraph_14')!;

    const decision = selectSpeakerCandidates({ targetSpan: target, memory, mentionInventory: mentions });

    expect(decision.selectedEntityIds).toEqual([]);
    expect(decision.evidence).toEqual([]);
    expect(decision.candidateSufficiency).toBe('insufficient');
  });

  it.each([
    '김민준에게 손님을 불러 달라고 부탁했다.',
    '김민준이 상태창을 불러와 확인했다.',
    '김민준은 한동안 창밖을 바라봤다.',
  ])('does not interpret action keywords as a reason to retrieve a candidate: %s', (sourceText) => {
    const candidate = character('character_distant', '김민준');
    const paragraphs = sourceParagraphs([
      sourceText,
      ...Array.from({ length: 13 }, (_, index) => `중간 서술 ${index}`),
      '“계속하겠습니다.”',
    ]);
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({
      novelId: 'book_1',
      characters: [candidate],
      relations: [],
    });
    const build = buildSpeakerAttributionChapter({
      bookId: 'book_1',
      contentRevisionId: `revision_keyword_independent_${textIntegrityHash(sourceText)}`,
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
      characters: [candidate],
      graphKnowledge,
    });
    const target = build.inventory.spanInventory.spans.find((span) => span.paragraphId === 'paragraph_14')!;
    const decision = build.candidateSelections[target.id]!;

    expect(decision.evidence).toEqual([]);
    expect(decision.candidateSufficiency).toBe('insufficient');
  });

  it('caps distant fallback candidates at the two most recent grounded characters', () => {
    const characters = ['김민준', '박서윤', '이현우', '최유진'].map((name, index) =>
      character(`character_${index}`, name),
    );
    const paragraphs = sourceParagraphs([
      ...characters.map((item) => `${item.canonicalName}이 준비를 마쳤다.`),
      ...Array.from({ length: 13 }, (_, index) => `중간 서술 ${index}`),
      '“대표님, 정하늘 팀장님 회의 준비가 끝났습니다.”',
    ]);
    const graphKnowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters, relations: [] });
    const build = buildSpeakerAttributionChapter({
      bookId: 'book_1',
      contentRevisionId: 'revision_distant_candidate_cap',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
      characters,
      graphKnowledge,
    });
    const target = build.inventory.spanInventory.spans.find((span) => span.paragraphId === 'paragraph_17')!;
    const decision = build.candidateSelections[target.id]!;
    const distantCharacterIds = decision.evidence
      .filter((evidence) => evidence.softReasons.includes('distant_scene_mention'))
      .map(
        (evidence) =>
          build.candidateMemories[target.sceneId]!.entities.find((entity) => entity.entityId === evidence.entityId)
            ?.characterId,
      );

    expect(distantCharacterIds).toEqual(['character_3', 'character_2']);
    expect(decision.supportingSourceMentionIds).toHaveLength(2);
  });

  it('projects redirected character ids to one speaker candidate and preserves their aliases', () => {
    const primary = { ...character('character_primary', 'Primary Name'), aliases: ['Primary Alias'] };
    const duplicate = { ...character('character_duplicate', 'Primary Name'), aliases: ['Later Alias'] };
    const characters = [primary, duplicate];
    const knowledge = backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters, relations: [] });
    const redirectedKnowledge = {
      ...knowledge,
      redirects: [
        {
          id: 'redirect_1',
          novelId: 'book_1',
          sourceCharacterId: duplicate.id,
          targetCharacterId: primary.id,
          operationId: 'operation_1',
          graphRevision: 'graph_1',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const paragraphs = sourceParagraphs(['Later Alias said hello.']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters,
      graphKnowledge: redirectedKnowledge,
    });
    const memory = buildCandidateMemoryView({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      sceneId: scenes.scenes[0]!.id,
      characters,
      graphKnowledge: redirectedKnowledge,
      mentionInventory: mentions,
      sourceEntities: [],
      addressEvents: [],
    });

    expect(memory.entities).toEqual([
      expect.objectContaining({
        characterId: primary.id,
        normalizedSurfaces: expect.arrayContaining(['primary alias', 'later alias']),
      }),
    ]);
    expect(mentions.mentions).toEqual(
      expect.arrayContaining([expect.objectContaining({ normalizedSurface: 'later alias', characterId: primary.id })]),
    );
  });

  it('links heuristic mentions to known characters without merging provisional identities across chapters', () => {
    const known = character('character_minjun', '민준');
    const paragraphs = sourceParagraphs(['민준이 말했다.']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      sceneInventory: scenes,
    });
    const mentions = buildSourceMentionInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs,
      spanInventory: spans,
      characters: [known],
    });
    expect(mentions.mentions.filter((mention) => mention.normalizedSurface === '민준')).toEqual(
      expect.arrayContaining([expect.objectContaining({ characterId: known.id })]),
    );
    expect(
      deriveSourceSpeakerEntities({
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        mentions: mentions.mentions,
        sceneOrdinalById: { [scenes.scenes[0]!.id]: 0 },
      }).some((entity) => entity.displayName === '민준'),
    ).toBe(false);

    const provisional = (id: string, chapterId: string, evidenceId: string, spanId: string): SpeakerEntityV1 => ({
      version: 'speaker-entity-v2',
      id,
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId,
      entityKind: 'provisional',
      status: 'ambiguous',
      displayName: '서윤',
      normalizedSurfaces: ['서윤'],
      effectiveFromScene: 0,
      effectiveToScene: 0,
      sceneId: `scene_${chapterId}`,
      provenance: ['speech_verb_subject'],
      trustLevel: 'low',
      evidenceMentionIds: [evidenceId],
      evidenceSpanIds: [spanId],
      promotionEligible: false,
      fingerprint: `fingerprint_${id}`,
    });
    const merged = coalesceSourceSpeakerEntitiesForMemory([
      provisional('entity_1', 'chapter_1', 'mention_1', 'span_1'),
      provisional('entity_2', 'chapter_2', 'mention_2', 'span_2'),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.every((entity) => entity.status === 'ambiguous' && !entity.promotionEligible)).toBe(true);
    expect(merged.map((entity) => entity.chapterId).sort()).toEqual(['chapter_1', 'chapter_2']);
  });
});

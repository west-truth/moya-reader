import { persistentId128 } from '@noveldesk/text-core/hash';
import type { AnalyzeCharacterBundleInput, CharacterBundleAnalysisResult } from './ai';
import type { CharacterBundleEvidence, CharacterBundleLLMResponse } from './character-bundle-contract';
import {
  CHARACTER_GRAPH_KNOWLEDGE_VERSION,
  isGenericCharacterReference,
  normalizeCharacterSurface,
  type CharacterEvidenceRefV2,
  type CharacterFactValidityV2,
  type CharacterGraphKnowledgeV2,
} from './character-graph-v2';

function sourceAnchor(input: AnalyzeCharacterBundleInput, evidence: CharacterBundleEvidence) {
  const source = input.chapters.find((item) => item.chapter.id === evidence.chapter_id);
  const paragraph = source?.paragraphs.find((item) => item.id === evidence.paragraph_id);
  return {
    chapterIndex: source?.chapter.index ?? 0,
    sourceHash: paragraph?.textHash ?? source?.chapter.textHash ?? 'missing-source-hash',
  };
}

function evidenceRows(
  input: AnalyzeCharacterBundleInput,
  observationId: string,
  values: readonly CharacterBundleEvidence[],
  observationCode: string,
): CharacterEvidenceRefV2[] {
  return values.map((evidence, index) => {
    const anchor = sourceAnchor(input, evidence);
    return {
      id: persistentId128('character_evidence_v2', [observationId, String(index), anchor.sourceHash]),
      novelId: input.novelId,
      chapterId: evidence.chapter_id,
      paragraphId: evidence.paragraph_id,
      sourceHash: anchor.sourceHash,
      observationCode,
      note: evidence.note,
    };
  });
}

function validity(
  input: AnalyzeCharacterBundleInput,
  evidence: readonly CharacterBundleEvidence[],
): CharacterFactValidityV2 {
  const indexes = evidence.map((item) => sourceAnchor(input, item).chapterIndex).filter(Number.isSafeInteger);
  return { fromChapterIndex: indexes.length > 0 ? Math.min(...indexes) : 0 };
}

export function characterBundleObservationsV2(input: {
  readonly source: AnalyzeCharacterBundleInput;
  readonly response: CharacterBundleLLMResponse;
  readonly result: CharacterBundleAnalysisResult;
}): CharacterGraphKnowledgeV2 {
  const evidence: CharacterEvidenceRefV2[] = [];
  const facts: CharacterGraphKnowledgeV2['facts'][number][] = [];
  const mentions: CharacterGraphKnowledgeV2['mentions'][number][] = [];
  const addressTerms: CharacterGraphKnowledgeV2['addressTerms'][number][] = [];
  const speechTraits: CharacterGraphKnowledgeV2['speechTraits'][number][] = [];
  const mergeCandidates: CharacterGraphKnowledgeV2['mergeCandidates'][number][] = [];

  input.response.new_or_updated_characters.forEach((observed, index) => {
    const character = input.result.discoveredGraph.characters[index];
    if (!character) return;
    const observationId = persistentId128('character_observation_v2', [
      input.source.novelId,
      input.source.bundleId,
      observed.temporary_id,
    ]);
    const rows = evidenceRows(input.source, observationId, observed.evidence, 'bundle_character');
    evidence.push(...rows);
    const evidenceIds = rows.map((row) => row.id);
    const activeValidity = validity(input.source, observed.evidence);
    facts.push({
      id: persistentId128('character_fact_v2', [observationId, 'canonical_name', observed.canonical_name]),
      novelId: input.source.novelId,
      characterId: character.id,
      field: 'canonical_name',
      value: observed.canonical_name,
      aliasType: 'name',
      confidence: observed.confidence,
      status: 'candidate',
      source: 'generated',
      lockedByUser: false,
      validity: activeValidity,
      evidenceIds,
    });
    for (const alias of observed.aliases) {
      if (isGenericCharacterReference(alias)) {
        mentions.push({
          id: persistentId128('character_mention_v2', [observationId, alias]),
          novelId: input.source.novelId,
          characterId: character.id,
          surface: alias,
          normalizedSurface: normalizeCharacterSurface(alias),
          kind: 'generic_reference',
          confidence: observed.confidence,
          status: 'candidate',
          validity: activeValidity,
          evidenceIds,
        });
      } else {
        facts.push({
          id: persistentId128('character_fact_v2', [observationId, 'typed_alias', alias]),
          novelId: input.source.novelId,
          characterId: character.id,
          field: 'typed_alias',
          value: alias,
          aliasType: 'untyped',
          confidence: observed.confidence,
          status: 'candidate',
          source: 'generated',
          lockedByUser: false,
          validity: activeValidity,
          evidenceIds,
        });
      }
    }
    for (const term of observed.honorifics ?? []) {
      addressTerms.push({
        id: persistentId128('character_address_v2', [observationId, term]),
        novelId: input.source.novelId,
        targetCharacterId: character.id,
        surface: term,
        normalizedSurface: normalizeCharacterSurface(term),
        direction: 'unknown',
        confidence: observed.confidence,
        status: 'candidate',
        validity: activeValidity,
        evidenceIds,
      });
    }
    if (observed.inferred_gender) {
      facts.push({
        id: persistentId128('character_fact_v2', [observationId, 'gender', observed.inferred_gender]),
        novelId: input.source.novelId,
        characterId: character.id,
        field: 'gender',
        value: observed.inferred_gender,
        confidence: observed.confidence,
        status: 'candidate',
        source: 'generated',
        lockedByUser: false,
        validity: activeValidity,
        evidenceIds,
      });
    }
    if (observed.speech_style) {
      speechTraits.push({
        id: persistentId128('character_speech_trait_v2', [observationId, observed.speech_style]),
        novelId: input.source.novelId,
        characterId: character.id,
        trait: 'speech_style',
        value: observed.speech_style,
        confidence: observed.confidence,
        status: 'candidate',
        validity: activeValidity,
        evidenceIds,
      });
    }
    for (const existingId of observed.possible_existing_character_ids ?? []) {
      if (existingId === character.id) continue;
      mergeCandidates.push({
        id: persistentId128('character_merge_candidate_v2', [character.id, existingId]),
        novelId: input.source.novelId,
        sourceCharacterId: character.id,
        targetCharacterId: existingId,
        positiveReasons: ['provider_possible_existing_reference'],
        negativeReasons: [],
        confidence: observed.confidence,
        status: 'open',
        evidenceIds,
      });
    }
  });

  const relationFacts = input.response.relations.flatMap((observed, index) => {
    const relation = input.result.discoveredGraph.relations[index];
    if (!relation) return [];
    const observationId = persistentId128('character_relation_observation_v2', [
      input.source.novelId,
      input.source.bundleId,
      String(index),
    ]);
    const rows = evidenceRows(input.source, observationId, observed.evidence, 'bundle_relation');
    evidence.push(...rows);
    const evidenceIds = rows.map((row) => row.id);
    const activeValidity = validity(input.source, observed.evidence);
    for (const term of observed.terms_used) {
      addressTerms.push({
        id: persistentId128('character_address_v2', [observationId, term]),
        novelId: input.source.novelId,
        speakerCharacterId: relation.sourceCharacterId,
        targetCharacterId: relation.targetCharacterId,
        surface: term,
        normalizedSurface: normalizeCharacterSurface(term),
        direction: 'speaker_to_target',
        confidence: observed.confidence,
        status: 'candidate',
        validity: activeValidity,
        evidenceIds,
      });
    }
    return [
      {
        ...relation,
        status: 'candidate' as const,
        validity: activeValidity,
        evidenceIds,
        lockedByUser: false,
      },
    ];
  });

  return {
    version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
    novelId: input.source.novelId,
    facts,
    mentions,
    addressTerms,
    speechTraits,
    relationFacts,
    evidence,
    mergeCandidates,
    redirects: [],
  };
}

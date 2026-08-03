import { Chapter, Character, LabeledSegment, Paragraph, UserCorrection } from '../domain/types';
import {
  candidateCharacterId,
  candidateRelationId,
  characterRelationId,
  labeledSegmentId,
  segmentTextIntegrityHash,
} from '../domain/identity/ai-identities';
import type { ProviderExecutionMetadata } from './provider-execution';
import type { LabelingContextPacketV2 } from './labeling-context-packet';
import type { LLMGenerationPolicyV2 } from './provider-generation-policy';
import {
  SpeakerOrdinal,
  type SceneSpeakerPacketV3,
  type ValidatedSpeakerWireV2,
} from './speaker-attribution/contracts';
import type { SpeakerOutputBudget } from './speaker-attribution/output-budget';
import { validateSpeakerWireV2 } from './speaker-attribution/validator';

export interface ChapterLabelingRecentTurn {
  paragraphId: string;
  speakerId: string;
  listenerIds: string[];
  emotion: string;
  text: string;
}

export interface ChapterLabelingInterlocutorEdge {
  sourceCharacterId: string;
  targetCharacterId: string;
  confidence?: number;
}

export interface ChapterLabelingPreviousContext {
  chapterId: string;
  summary: string;
  activeCharacterIds: string[];
  unresolved: string[];
  version?: 'episode-context-v2';
  scene?: string;
  interlocutorEdges?: ChapterLabelingInterlocutorEdge[];
  recentTurns?: ChapterLabelingRecentTurn[];
  unresolvedReferences?: string[];
  correctionMemoryCursor?: string;
  sourceWindowId?: string;
  sourceArtifactId?: string;
}

export interface LabelChapterSegmentsInput {
  novelId: string;
  chapter: Chapter;
  paragraphs: Paragraph[];
  windowId?: string;
  inputRevisionId?: string;
  knownCharacters?: Character[];
  characterGraph?: CharacterGraph;
  previousEpisodeContext?: ChapterLabelingPreviousContext;
  userCorrections?: UserCorrection[];
  contextPacket?: LabelingContextPacketV2;
  contextHaloParagraphs?: Paragraph[];
  signal?: AbortSignal;
}

export interface ChapterLabelingResult {
  characters: Character[];
  segments: LabeledSegment[];
  episodeContextSummary?: {
    chapterId: string;
    scene: string;
    activeCharacterIds: string[];
    unresolved: string[];
    summaryForNextChapter?: string;
    interlocutorEdges?: ChapterLabelingInterlocutorEdge[];
  };
  uncertainties?: ChapterLabelingUncertainty[];
  segmentAnnotations?: Record<string, ChapterLabelingSegmentAnnotation>;
}

export interface ChapterLabelingUncertainty {
  paragraphId: string;
  startOffset: number;
  endOffset: number;
  reasonCode: string;
  candidateIds: string[];
}

export interface ChapterLabelingSegmentAnnotation {
  evidenceCodes: string[];
  prosodyIntent?: {
    pace?: string;
    intensity?: string;
    delivery?: string;
  };
}

export interface ChapterLabelingRepairIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly segmentId?: string;
  readonly paragraphId?: string;
}

export interface RepairChapterLabelsInput extends LabelChapterSegmentsInput {
  existingResult: ChapterLabelingResult;
  validationIssues: ChapterLabelingRepairIssue[];
  baseArtifactId?: string;
  baseArtifactHash?: string;
  issueIds?: string[];
}

export interface CharacterRelation {
  id: string;
  novelId: string;
  sourceCharacterId: string;
  targetCharacterId: string;
  relationLabel: string;
  termsUsedBySource: string[];
  termsUsedByTarget: string[];
  confidence: number;
  evidence?: string[];
}

export interface CharacterGraph {
  novelId: string;
  characters: Character[];
  relations: CharacterRelation[];
}

export interface MergeCharacterGraphInput {
  novelId: string;
  existingGraph: CharacterGraph;
  discoveredGraph: CharacterGraph;
  sourceContext?: {
    bundleId?: string;
    chapterIds?: string[];
    summary?: string;
  };
  userCorrections?: UserCorrection[];
  signal?: AbortSignal;
}

export interface CharacterBundleChapterInput {
  chapter: Chapter;
  paragraphs: Paragraph[];
}

export interface AnalyzeCharacterBundleInput {
  novelId: string;
  bundleId: string;
  chapters: CharacterBundleChapterInput[];
  existingGraph?: CharacterGraph;
  previousBundleSummary?: string;
  userCorrections?: UserCorrection[];
  signal?: AbortSignal;
}

export interface CharacterBundleAnalysisResult {
  novelId: string;
  bundleId: string;
  sourceChapterIds: string[];
  discoveredGraph: CharacterGraph;
  bundleSummaryForNext?: string;
  observationsV2?: import('./character-graph-v2').CharacterGraphKnowledgeV2;
}

export interface AttributeSpeakersInput {
  readonly packet: SceneSpeakerPacketV3;
  readonly generationPolicy: LLMGenerationPolicyV2;
  readonly outputBudget: SpeakerOutputBudget;
  readonly mode?: 'primary' | 'independent_escalation';
  readonly signal?: AbortSignal;
}

export interface SpeakerAttributionResultV2 {
  readonly packetFingerprint: string;
  readonly validatedWire: ValidatedSpeakerWireV2;
}

export interface AIProvider {
  readonly providerId: string;
  readonly displayName: string;
  labelChapterSegments(input: LabelChapterSegmentsInput): Promise<ChapterLabelingResult>;
  attributeSpeakers?(input: AttributeSpeakersInput): Promise<SpeakerAttributionResultV2>;
  analyzeCharacterBundle?(input: AnalyzeCharacterBundleInput): Promise<CharacterBundleAnalysisResult>;
  repairChapterLabels?(input: RepairChapterLabelsInput): Promise<ChapterLabelingResult>;
  mergeCharacterGraph?(input: MergeCharacterGraphInput): Promise<CharacterGraph>;
  takeExecutionMetadata?(): ProviderExecutionMetadata | undefined;
}

const mockColors = ['#3b82f6', '#ef476f', '#2fbf71', '#f59e0b', '#9b5de5'];

const mockCharacters = [
  { id: 'char_hyun', canonicalName: '강현우', aliases: ['현우', '강 대리'] },
  { id: 'char_minseo', canonicalName: '박민서', aliases: ['팀장님', '민서'] },
  { id: 'char_system', canonicalName: '시스템', aliases: ['상태창', '알림'] },
];

function detectSegmentType(text: string): LabeledSegment['type'] {
  const trimmed = text.trim();
  if (/^\[.+\]$/.test(trimmed) || /^<.+>$/.test(trimmed)) return 'system_message';
  if (/^(띠링|쿵|쾅|철컥|끼익|삐빅)/.test(trimmed)) return 'sfx';
  if (/^(작가|후기|공지)/.test(trimmed)) return 'author_note';
  if (/^["“「『'].*["”」』']$/.test(trimmed)) return 'quoted_dialogue';
  if (/^[가-힣A-Za-z0-9_ -]{1,12}\s*[:：]/.test(trimmed)) return 'plain_dialogue';
  if (/^\(.+\)$/.test(trimmed)) return 'inner_monologue';
  return 'narration';
}

function inferSpeakerId(text: string, type: LabeledSegment['type'], index: number): string {
  if (type === 'system_message') return 'system';
  if (type === 'narration' || type === 'author_note' || type === 'sfx') return 'narrator';
  if (text.includes('팀장') || text.includes('민서')) return 'char_minseo';
  if (text.includes('현우') || text.includes('강 대리')) return 'char_hyun';
  return index % 2 === 0 ? 'char_hyun' : 'unknown';
}

export class MockAIProvider implements AIProvider {
  readonly providerId = 'mock';
  readonly displayName = 'Mock AI (로컬)';

  async labelChapterSegments(input: LabelChapterSegmentsInput): Promise<ChapterLabelingResult> {
    const characters: Character[] = mockCharacters.map((character, index) => ({
      ...character,
      novelId: input.novelId,
      color: mockColors[index % mockColors.length],
      confidence: 0.74 + index * 0.06,
      description:
        character.id === 'char_system'
          ? '상태창과 시스템 메시지를 읽는 보조 음성입니다.'
          : 'Mock 분석으로 추정한 등장인물입니다. 실제 LLM 요청은 발생하지 않습니다.',
      isUserConfirmed: false,
    }));

    const segments = input.paragraphs.map<LabeledSegment>((paragraph, index) => {
      const type = detectSegmentType(paragraph.text);
      const speakerId = inferSpeakerId(paragraph.text, type, index);
      const confidence = speakerId === 'unknown' ? 0.48 : type === 'narration' ? 0.98 : 0.76;
      const segmentTextHash = segmentTextIntegrityHash(paragraph.text);
      return {
        id: labeledSegmentId({
          novelId: input.novelId,
          chapterId: input.chapter.id,
          paragraphId: paragraph.id,
          startOffset: 0,
          endOffset: paragraph.text.length,
          segmentTextHash,
        }),
        novelId: input.novelId,
        chapterId: input.chapter.id,
        paragraphId: paragraph.id,
        segmentIndex: index,
        startOffset: 0,
        endOffset: paragraph.text.length,
        segmentTextHash,
        type,
        speakerId,
        candidateSpeakers: speakerId === 'unknown' ? ['char_hyun', 'char_minseo'] : [speakerId],
        listenerIds: [],
        emotion: type === 'system_message' ? 'system' : 'neutral',
        confidence,
        evidence: '로컬 MockAIProvider가 문장 형태와 키워드만으로 추정했습니다.',
        voiceProfileId: speakerId === 'system' ? 'system_default' : 'narrator_default',
        isUserCorrected: false,
      };
    });

    return { characters, segments };
  }

  async attributeSpeakers(input: AttributeSpeakersInput): Promise<SpeakerAttributionResultV2> {
    const selected = input.packet.targets.map((target) => target[4][0] ?? SpeakerOrdinal.unknown);
    const reviewPositions = selected.flatMap((ordinal, position) =>
      ordinal === SpeakerOrdinal.unknown ? [position] : [],
    );
    const wire = {
      v: 2 as const,
      f: input.packet.fingerprint,
      s: selected,
      q: selected.map((ordinal) => (ordinal === SpeakerOrdinal.unknown ? 400 : 780)),
      e: selected.map(() => 0),
      u: reviewPositions,
      c: reviewPositions.map((position) => input.packet.targets[position]?.[4].slice(0, 3) ?? []),
      r: reviewPositions.map(() => 1),
      x: [] as readonly (readonly [number, number])[],
    };
    return {
      packetFingerprint: input.packet.fingerprint,
      validatedWire: validateSpeakerWireV2(input.packet, wire),
    };
  }

  async repairChapterLabels(input: RepairChapterLabelsInput): Promise<ChapterLabelingResult> {
    const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
    const knownSpeakerIds = new Set([
      'narrator',
      'system',
      'unknown',
      ...(input.knownCharacters ?? []).map((character) => character.id),
      ...(input.characterGraph?.characters ?? []).map((character) => character.id),
      ...input.existingResult.characters.map((character) => character.id),
    ]);
    const segments = input.existingResult.segments.map<LabeledSegment>((segment, index) => {
      const paragraph = paragraphById.get(segment.paragraphId);
      const startOffset = Number.isInteger(segment.startOffset) ? segment.startOffset : 0;
      const endOffset =
        paragraph && Number.isInteger(segment.endOffset)
          ? Math.min(Math.max(segment.endOffset, startOffset + 1), paragraph.text.length)
          : segment.endOffset;
      const validRange = Boolean(
        paragraph && startOffset >= 0 && endOffset > startOffset && endOffset <= paragraph.text.length,
      );
      const segmentText = validRange && paragraph ? paragraph.text.slice(startOffset, endOffset) : '';
      const speakerId = knownSpeakerIds.has(segment.speakerId) ? segment.speakerId : 'unknown';
      return {
        ...segment,
        novelId: input.novelId,
        chapterId: input.chapter.id,
        segmentIndex: index,
        startOffset,
        endOffset,
        segmentTextHash: validRange ? segmentTextIntegrityHash(segmentText) : segment.segmentTextHash,
        speakerId,
        candidateSpeakers: segment.candidateSpeakers,
        evidence:
          segment.evidence ||
          'Mock repair preserved or normalized existing label metadata without an external LLM request.',
      };
    });
    return {
      characters: input.existingResult.characters,
      segments,
      episodeContextSummary: input.existingResult.episodeContextSummary,
    };
  }

  async analyzeCharacterBundle(input: AnalyzeCharacterBundleInput): Promise<CharacterBundleAnalysisResult> {
    const bundleText = input.chapters
      .flatMap((chapter) => chapter.paragraphs.map((paragraph) => paragraph.text))
      .join('\n');
    const found = mockCharacters.filter((character) =>
      [character.canonicalName, ...character.aliases].some((alias) => bundleText.includes(alias)),
    );
    const characters = (found.length ? found : mockCharacters.slice(0, 2)).map<Character>((character, index) => ({
      id: candidateCharacterId(input.novelId, input.bundleId, character.id),
      novelId: input.novelId,
      canonicalName: character.canonicalName,
      aliases: character.aliases,
      color: mockColors[index % mockColors.length],
      description: 'Mock bundle analysis candidate. 실제 LLM 요청은 발생하지 않습니다.',
      confidence: 0.72 + index * 0.06,
      isUserConfirmed: false,
    }));
    const relations: CharacterRelation[] =
      characters.length >= 2
        ? [
            {
              id: candidateRelationId({
                novelId: input.novelId,
                bundleId: input.bundleId,
                sourceCharacterId: characters[0].id,
                targetCharacterId: characters[1].id,
                relationLabel: 'bundle_cooccurrence',
              }),
              novelId: input.novelId,
              sourceCharacterId: characters[0].id,
              targetCharacterId: characters[1].id,
              relationLabel: 'bundle_cooccurrence',
              termsUsedBySource: [],
              termsUsedByTarget: [],
              confidence: 0.55,
              evidence: input.chapters.slice(0, 2).map((chapter) => chapter.chapter.id),
            },
          ]
        : [];
    return {
      novelId: input.novelId,
      bundleId: input.bundleId,
      sourceChapterIds: input.chapters.map((chapter) => chapter.chapter.id),
      discoveredGraph: {
        novelId: input.novelId,
        characters,
        relations,
      },
      bundleSummaryForNext: `${input.chapters.length}개 화에서 ${characters.map((character) => character.canonicalName).join(', ')} 후보를 추출했습니다.`,
    };
  }

  async mergeCharacterGraph(input: MergeCharacterGraphInput): Promise<CharacterGraph> {
    const charactersById = new Map<string, Character>();
    const mergeCharacter = (incoming: Character, source: 'existing' | 'discovered') => {
      const existing = charactersById.get(incoming.id);

      if (!existing) {
        const next = {
          ...incoming,
          novelId: input.novelId,
          isUserConfirmed: source === 'existing' && incoming.isUserConfirmed,
        };
        charactersById.set(next.id, next);
        return;
      }

      const confirmed = existing.isUserConfirmed ? existing : undefined;
      const aliases = [
        ...new Set(
          [...existing.aliases, ...incoming.aliases, incoming.canonicalName]
            .map((alias) => alias.trim())
            .filter(Boolean),
        ),
      ];
      const next: Character = {
        ...existing,
        canonicalName: confirmed?.canonicalName ?? existing.canonicalName,
        aliases: confirmed?.aliases ?? aliases.filter((alias) => alias !== existing.canonicalName),
        color: confirmed?.color ?? existing.color,
        description: confirmed?.description ?? existing.description ?? incoming.description,
        confidence: Math.max(existing.confidence, incoming.confidence),
        isUserConfirmed: existing.isUserConfirmed,
      };
      charactersById.set(next.id, next);
    };

    for (const character of input.existingGraph.characters) mergeCharacter(character, 'existing');
    for (const character of input.discoveredGraph.characters) mergeCharacter(character, 'discovered');

    const knownCharacterIds = new Set(charactersById.keys());
    const relationsByKey = new Map<string, CharacterRelation>();
    const mergeRelation = (relation: CharacterRelation) => {
      const sourceCharacterId = relation.sourceCharacterId;
      const targetCharacterId = relation.targetCharacterId;
      if (sourceCharacterId === targetCharacterId) return;
      if (!knownCharacterIds.has(sourceCharacterId) || !knownCharacterIds.has(targetCharacterId)) return;
      const relationLabel = relation.relationLabel.trim() || 'related';
      const key = `${sourceCharacterId}:${targetCharacterId}:${relationLabel.toLocaleLowerCase()}`;
      const existing = relationsByKey.get(key);
      const next: CharacterRelation = {
        ...relation,
        id:
          existing?.id ??
          relation.id ??
          characterRelationId({
            novelId: input.novelId,
            sourceCharacterId,
            targetCharacterId,
            relationLabel,
          }),
        novelId: input.novelId,
        sourceCharacterId,
        targetCharacterId,
        relationLabel,
        termsUsedBySource: [...new Set([...(existing?.termsUsedBySource ?? []), ...relation.termsUsedBySource])],
        termsUsedByTarget: [...new Set([...(existing?.termsUsedByTarget ?? []), ...relation.termsUsedByTarget])],
        confidence: Math.max(existing?.confidence ?? 0, relation.confidence),
        evidence: [...new Set([...(existing?.evidence ?? []), ...(relation.evidence ?? [])])],
      };
      relationsByKey.set(key, next);
    };

    for (const relation of input.existingGraph.relations) mergeRelation(relation);
    for (const relation of input.discoveredGraph.relations) mergeRelation(relation);

    return {
      novelId: input.novelId,
      characters: [...charactersById.values()],
      relations: [...relationsByKey.values()],
    };
  }
}

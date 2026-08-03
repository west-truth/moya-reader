import type { Character, Paragraph, UserCorrection } from '../domain/types';
import type { CharacterGraph, ChapterLabelingPreviousContext } from './ai';
import {
  normalizeCharacterSurface,
  selectCharacterGraphSliceV2,
  type CharacterGraphKnowledgeV2,
  type CharacterGraphSliceV2,
} from './character-graph-v2';
import {
  buildProviderAdmissionSnapshot,
  resolveLLMCapabilitySnapshot,
  resolveProviderTaskProfile,
  type LLMCapabilitySnapshot,
  type ProviderAdmissionSnapshot,
  type ProviderTaskProfileSnapshot,
} from './provider-capability';

export const LABELING_CONTEXT_PACKET_VERSION = 'labeling-context-v2' as const;

export interface LabelingContextCapabilitySnapshot extends LLMCapabilitySnapshot {
  readonly modelId?: string;
  readonly contextWindowTokens: number;
  readonly availableInputTokens: number;
  readonly tokenCountMode: 'estimated_characters';
  readonly estimatedCharactersPerToken: number;
  readonly safetyFactor: number;
}

export interface LabelingContextHaloParagraph {
  readonly paragraphId: string;
  readonly index: number;
  readonly side: 'before' | 'after';
  readonly text: string;
  readonly textHash: string;
}

export interface LabelingCorrectionMemoryRule {
  readonly correctionId: string;
  readonly correctionType: UserCorrection['correctionType'];
  readonly applyScope: UserCorrection['applyScope'];
  readonly chapterId: string;
  readonly paragraphId?: string;
  readonly segmentId?: string;
  readonly normalizedValue: unknown;
  readonly precedence: 'direct' | 'chapter' | 'future_pattern' | 'global';
  readonly createdAt: string;
}

export interface LabelingContextSelectionTrace {
  readonly selectedCharacterReasons: Readonly<Record<string, readonly string[]>>;
  readonly selectedCorrectionIds: readonly string[];
  readonly omitted: readonly string[];
  readonly warnings: readonly string[];
}

export interface LabelingContextBudgetSnapshot {
  readonly targetCharacters: number;
  readonly haloCharacters: number;
  readonly graphCharacters: number;
  readonly correctionCharacters: number;
  readonly sceneCharacters: number;
  readonly staticInstructionCharacters: number;
  readonly schemaCharacters: number;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly availableInputTokens: number;
  readonly admission: 'accepted' | 'rejected';
}

export interface LabelingContextPacketV2 {
  readonly version: typeof LABELING_CONTEXT_PACKET_VERSION;
  readonly novelId: string;
  readonly chapterId: string;
  readonly targetParagraphIds: readonly string[];
  readonly halo: readonly LabelingContextHaloParagraph[];
  readonly sceneContext?: ChapterLabelingPreviousContext;
  readonly relevantCharacterGraph: CharacterGraph;
  readonly characterKnowledge?: CharacterGraphSliceV2;
  readonly correctionMemory: readonly LabelingCorrectionMemoryRule[];
  readonly capability: LabelingContextCapabilitySnapshot;
  readonly taskProfile: ProviderTaskProfileSnapshot;
  readonly admissionSnapshot: ProviderAdmissionSnapshot;
  readonly budget: LabelingContextBudgetSnapshot;
  readonly selectionTrace: LabelingContextSelectionTrace;
}

export interface BuildLabelingContextPacketInput {
  readonly novelId: string;
  readonly chapterId: string;
  readonly targetParagraphs: readonly Paragraph[];
  readonly haloParagraphs?: readonly Paragraph[];
  readonly characterGraph: CharacterGraph;
  readonly characterGraphKnowledge?: CharacterGraphKnowledgeV2;
  readonly chapterIndex?: number;
  readonly sceneId?: string;
  readonly previousEpisodeContext?: ChapterLabelingPreviousContext;
  readonly corrections?: readonly UserCorrection[];
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly staticInstructionCharacters?: number;
  readonly schemaCharacters?: number;
}

export interface ResolveLabelingContextCapabilityInput {
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export class LabelingContextBudgetExceededError extends Error {
  readonly code = 'labeling_context_budget_exceeded';

  constructor(
    readonly estimatedInputTokens: number,
    readonly availableInputTokens: number,
  ) {
    super(`Labeling context requires ${estimatedInputTokens} input tokens, budget is ${availableInputTokens}`);
    this.name = 'LabelingContextBudgetExceededError';
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function resolveLabelingContextCapability(
  input: ResolveLabelingContextCapabilityInput,
): LabelingContextCapabilitySnapshot {
  const snapshot = resolveLLMCapabilitySnapshot(input);
  const contextWindowTokens = snapshot.maxContextTokens;
  return {
    ...snapshot,
    modelId: input.modelId,
    contextWindowTokens,
    availableInputTokens: Math.max(
      1,
      Math.floor(contextWindowTokens * snapshot.safetyFactor) - snapshot.maxOutputTokens,
    ),
    tokenCountMode: 'estimated_characters',
  };
}

export function recommendedTargetLabelingCharacters(
  capability: LabelingContextCapabilitySnapshot,
  requestedCharacters = 12_000,
): number {
  const sourceShare = 0.55;
  const reservedStaticCharacters = 4_000;
  const modelBound = Math.max(
    256,
    Math.floor(
      capability.availableInputTokens * capability.estimatedCharactersPerToken * sourceShare - reservedStaticCharacters,
    ),
  );
  return Math.max(1, Math.min(Math.floor(requestedCharacters), modelBound));
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonCharacters(value: unknown): number {
  return JSON.stringify(value).length;
}

function characterNames(character: Character): string[] {
  return [character.canonicalName, ...character.aliases].map((value) => normalizedText(value.trim())).filter(Boolean);
}

function correctionPrecedence(
  correction: UserCorrection,
  targetParagraphIds: ReadonlySet<string>,
  chapterId: string,
): LabelingCorrectionMemoryRule['precedence'] | undefined {
  if (correction.paragraphId && targetParagraphIds.has(correction.paragraphId)) return 'direct';
  if (correction.applyScope === 'segment') return undefined;
  if (correction.applyScope === 'chapter' && correction.chapterId === chapterId) return 'chapter';
  if (correction.applyScope === 'future_pattern') return 'future_pattern';
  if (correction.applyScope === 'global') return 'global';
  return undefined;
}

function correctionRules(
  corrections: readonly UserCorrection[],
  targetParagraphIds: ReadonlySet<string>,
  chapterId: string,
  limit: number,
): LabelingCorrectionMemoryRule[] {
  const rank: Record<LabelingCorrectionMemoryRule['precedence'], number> = {
    direct: 4,
    chapter: 3,
    future_pattern: 2,
    global: 1,
  };
  return corrections
    .flatMap((correction): LabelingCorrectionMemoryRule[] => {
      const precedence = correctionPrecedence(correction, targetParagraphIds, chapterId);
      return precedence
        ? [
            {
              correctionId: correction.id,
              correctionType: correction.correctionType,
              applyScope: correction.applyScope,
              chapterId: correction.chapterId,
              paragraphId: correction.paragraphId,
              segmentId: correction.segmentId,
              normalizedValue: parseJsonOrText(correction.afterJson),
              precedence,
              createdAt: correction.createdAt,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        rank[b.precedence] - rank[a.precedence] ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.correctionId.localeCompare(b.correctionId),
    )
    .slice(0, limit);
}

function selectCharacterGraph(
  graph: CharacterGraph,
  searchText: string,
  previousContext: ChapterLabelingPreviousContext | undefined,
  correctionMemory: readonly LabelingCorrectionMemoryRule[],
  maxCharacters: number,
  maxRelations: number,
): { graph: CharacterGraph; reasons: Record<string, string[]>; seedIds: Set<string> } {
  const reasons: Record<string, string[]> = {};
  const seedIds = new Set<string>();
  const correctionText = normalizedText(JSON.stringify(correctionMemory));
  const add = (characterId: string, reason: string) => {
    seedIds.add(characterId);
    const values = reasons[characterId] ?? [];
    if (!values.includes(reason)) values.push(reason);
    reasons[characterId] = values;
  };

  for (const character of graph.characters) {
    const names = characterNames(character);
    if (names.some((name) => name && searchText.includes(name))) add(character.id, 'target_or_halo_name');
    if (names.some((name) => name && correctionText.includes(name))) add(character.id, 'correction_memory');
    if (correctionText.includes(normalizedText(character.id))) add(character.id, 'correction_character_id');
  }
  for (const characterId of previousContext?.activeCharacterIds ?? []) add(characterId, 'active_scene');
  for (const turn of previousContext?.recentTurns ?? []) {
    add(turn.speakerId, 'recent_turn_speaker');
    for (const listenerId of turn.listenerIds) add(listenerId, 'recent_turn_listener');
  }

  if (seedIds.size === 0) {
    for (const character of [...graph.characters]
      .filter((item) => item.isUserConfirmed)
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, 4)) {
      add(character.id, 'confirmed_fallback');
    }
  }

  const characterLimit = Math.max(maxCharacters, seedIds.size);
  const selectedIds = new Set(seedIds);
  const candidateRelations = [...graph.relations]
    .filter((relation) => seedIds.has(relation.sourceCharacterId) || seedIds.has(relation.targetCharacterId))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, maxRelations);
  for (const relation of candidateRelations) {
    if (selectedIds.size >= characterLimit) break;
    selectedIds.add(relation.sourceCharacterId);
    selectedIds.add(relation.targetCharacterId);
    if (!reasons[relation.sourceCharacterId]) reasons[relation.sourceCharacterId] = ['one_hop_relation'];
    if (!reasons[relation.targetCharacterId]) reasons[relation.targetCharacterId] = ['one_hop_relation'];
  }

  const characters = graph.characters
    .filter((character) => selectedIds.has(character.id))
    .sort(
      (a, b) =>
        Number(seedIds.has(b.id)) - Number(seedIds.has(a.id)) ||
        b.confidence - a.confidence ||
        a.id.localeCompare(b.id),
    )
    .slice(0, characterLimit)
    .sort((a, b) => a.id.localeCompare(b.id));
  const finalIds = new Set(characters.map((character) => character.id));
  const relations = candidateRelations.filter(
    (relation) => finalIds.has(relation.sourceCharacterId) && finalIds.has(relation.targetCharacterId),
  );
  return { graph: { novelId: graph.novelId, characters, relations }, reasons, seedIds };
}

function haloPayload(
  paragraphs: readonly Paragraph[],
  targetParagraphs: readonly Paragraph[],
  limitPerSide: number,
): LabelingContextHaloParagraph[] {
  const firstIndex = targetParagraphs.at(0)?.index ?? 0;
  const lastIndex = targetParagraphs.at(-1)?.index ?? firstIndex;
  const before = paragraphs
    .filter((paragraph) => paragraph.index < firstIndex)
    .sort((a, b) => b.index - a.index)
    .slice(0, limitPerSide)
    .reverse();
  const after = paragraphs
    .filter((paragraph) => paragraph.index > lastIndex)
    .sort((a, b) => a.index - b.index)
    .slice(0, limitPerSide);
  return [
    ...before.map((paragraph) => ({ paragraph, side: 'before' as const })),
    ...after.map((paragraph) => ({ paragraph, side: 'after' as const })),
  ].map(({ paragraph, side }) => ({
    paragraphId: paragraph.id,
    index: paragraph.index,
    side,
    text: paragraph.text,
    textHash: paragraph.textHash,
  }));
}

function trimSceneContext(
  context: ChapterLabelingPreviousContext | undefined,
  maxRecentTurns: number,
): ChapterLabelingPreviousContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    activeCharacterIds: [...context.activeCharacterIds],
    unresolved: [...context.unresolved],
    interlocutorEdges: context.interlocutorEdges?.slice(-16),
    recentTurns: context.recentTurns?.slice(-maxRecentTurns),
    unresolvedReferences: context.unresolvedReferences?.slice(-16),
  };
}

function estimateInputTokens(input: {
  targetCharacters: number;
  halo: readonly LabelingContextHaloParagraph[];
  graph: CharacterGraph;
  knowledge?: CharacterGraphSliceV2;
  corrections: readonly LabelingCorrectionMemoryRule[];
  sceneContext?: ChapterLabelingPreviousContext;
  staticInstructionCharacters: number;
  schemaCharacters: number;
  charactersPerToken: number;
}): {
  tokens: number;
  components: Omit<
    LabelingContextBudgetSnapshot,
    'estimatedInputTokens' | 'reservedOutputTokens' | 'availableInputTokens' | 'admission'
  >;
} {
  const haloCharacters = jsonCharacters(input.halo);
  const graphCharacters = jsonCharacters(input.graph) + (input.knowledge ? jsonCharacters(input.knowledge) : 0);
  const correctionCharacters = jsonCharacters(input.corrections);
  const sceneCharacters = input.sceneContext ? jsonCharacters(input.sceneContext) : 0;
  const total =
    input.targetCharacters +
    haloCharacters +
    graphCharacters +
    correctionCharacters +
    sceneCharacters +
    input.staticInstructionCharacters +
    input.schemaCharacters;
  return {
    tokens: Math.ceil(total / input.charactersPerToken),
    components: {
      targetCharacters: input.targetCharacters,
      haloCharacters,
      graphCharacters,
      correctionCharacters,
      sceneCharacters,
      staticInstructionCharacters: input.staticInstructionCharacters,
      schemaCharacters: input.schemaCharacters,
    },
  };
}

export function buildLabelingContextPacket(input: BuildLabelingContextPacketInput): LabelingContextPacketV2 {
  const options = input.providerOptions ?? {};
  const capability = resolveLabelingContextCapability({
    providerId: input.providerId,
    modelId: input.modelId,
    providerOptions: options,
  });
  const { maxOutputTokens, availableInputTokens, estimatedCharactersPerToken } = capability;
  const targetParagraphIds = new Set(input.targetParagraphs.map((paragraph) => paragraph.id));
  const maxCorrections = positiveInteger(options.maxContextCorrections, 20);
  let correctionMemory = correctionRules(input.corrections ?? [], targetParagraphIds, input.chapterId, maxCorrections);
  const targetText = input.targetParagraphs.map((paragraph) => paragraph.text).join('\n');
  const haloSource = input.haloParagraphs ?? [];
  let halo = haloPayload(haloSource, input.targetParagraphs, nonNegativeInteger(options.contextHaloParagraphs, 2));
  let sceneContext = trimSceneContext(input.previousEpisodeContext, positiveInteger(options.maxContextRecentTurns, 8));
  const searchText = normalizedText([targetText, ...halo.map((item) => item.text)].join('\n'));
  const graphSelection = selectCharacterGraph(
    input.characterGraph,
    searchText,
    sceneContext,
    correctionMemory,
    positiveInteger(options.maxContextCharacters, 24),
    positiveInteger(options.maxContextRelations, 48),
  );
  let characterKnowledge: CharacterGraphSliceV2 | undefined;
  if (input.characterGraphKnowledge) {
    const activeSurfaces = [
      ...input.characterGraphKnowledge.facts.map((fact) => fact.value),
      ...input.characterGraphKnowledge.mentions.map((mention) => mention.surface),
      ...input.characterGraphKnowledge.addressTerms.map((term) => term.surface),
    ].filter((surface) => searchText.includes(normalizeCharacterSurface(surface)));
    characterKnowledge = selectCharacterGraphSliceV2({
      graph: input.characterGraph,
      knowledge: input.characterGraphKnowledge,
      chapterIndex: input.chapterIndex ?? 0,
      sceneId: input.sceneId,
      surfaces: activeSurfaces,
      requiredCharacterIds: [...graphSelection.seedIds],
    });
  }
  const characterById = new Map(
    [...graphSelection.graph.characters, ...(characterKnowledge?.graph.characters ?? [])].map((character) => [
      character.id,
      character,
    ]),
  );
  const relationById = new Map(
    [...graphSelection.graph.relations, ...(characterKnowledge?.graph.relations ?? [])].map((relation) => [
      relation.id,
      relation,
    ]),
  );
  let relevantCharacterGraph: CharacterGraph = {
    novelId: input.characterGraph.novelId,
    characters: [...characterById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    relations: [...relationById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const omitted: string[] = [];
  const warnings: string[] = [];
  const targetCharacters = input.targetParagraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  const staticInstructionCharacters = Math.max(0, Math.floor(input.staticInstructionCharacters ?? 3_000));
  const schemaCharacters = Math.max(0, Math.floor(input.schemaCharacters ?? 0));

  let estimate = estimateInputTokens({
    targetCharacters,
    halo,
    graph: relevantCharacterGraph,
    knowledge: characterKnowledge,
    corrections: correctionMemory,
    sceneContext,
    staticInstructionCharacters,
    schemaCharacters,
    charactersPerToken: estimatedCharactersPerToken,
  });
  while (estimate.tokens > availableInputTokens && relevantCharacterGraph.relations.length > 0) {
    relevantCharacterGraph = { ...relevantCharacterGraph, relations: relevantCharacterGraph.relations.slice(0, -1) };
    omitted.push('low_relevance_relation');
    estimate = estimateInputTokens({
      targetCharacters,
      halo,
      graph: relevantCharacterGraph,
      knowledge: characterKnowledge,
      corrections: correctionMemory,
      sceneContext,
      staticInstructionCharacters,
      schemaCharacters,
      charactersPerToken: estimatedCharactersPerToken,
    });
  }
  while (estimate.tokens > availableInputTokens && correctionMemory.length > 0) {
    correctionMemory = correctionMemory.slice(0, -1);
    omitted.push('lower_precedence_correction');
    estimate = estimateInputTokens({
      targetCharacters,
      halo,
      graph: relevantCharacterGraph,
      knowledge: characterKnowledge,
      corrections: correctionMemory,
      sceneContext,
      staticInstructionCharacters,
      schemaCharacters,
      charactersPerToken: estimatedCharactersPerToken,
    });
  }
  while (estimate.tokens > availableInputTokens && (sceneContext?.recentTurns?.length ?? 0) > 0) {
    sceneContext = { ...sceneContext!, recentTurns: sceneContext!.recentTurns!.slice(1) };
    omitted.push('oldest_recent_turn');
    estimate = estimateInputTokens({
      targetCharacters,
      halo,
      graph: relevantCharacterGraph,
      knowledge: characterKnowledge,
      corrections: correctionMemory,
      sceneContext,
      staticInstructionCharacters,
      schemaCharacters,
      charactersPerToken: estimatedCharactersPerToken,
    });
  }
  while (estimate.tokens > availableInputTokens && halo.length > 0) {
    halo = halo.length === 1 ? [] : halo.slice(1, -1);
    omitted.push('outer_halo_paragraph');
    estimate = estimateInputTokens({
      targetCharacters,
      halo,
      graph: relevantCharacterGraph,
      knowledge: characterKnowledge,
      corrections: correctionMemory,
      sceneContext,
      staticInstructionCharacters,
      schemaCharacters,
      charactersPerToken: estimatedCharactersPerToken,
    });
  }
  if (estimate.tokens > availableInputTokens) warnings.push('minimum_target_exceeds_model_input_budget');
  const requestProfileId =
    typeof options.requestProfileId === 'string' && options.requestProfileId.trim()
      ? options.requestProfileId.trim()
      : 'chapter-labeling-v2-strict-tts';
  const taskProfile = resolveProviderTaskProfile({
    jobType: 'chapter_segment_labeling',
    requestProfile: {
      id: requestProfileId,
      promptVersion:
        typeof options.promptVersion === 'string' && options.promptVersion.trim()
          ? options.promptVersion.trim()
          : requestProfileId,
      schemaVersion:
        typeof options.schemaVersion === 'string' && options.schemaVersion.trim()
          ? options.schemaVersion.trim()
          : 'chapter-labeling-v2',
    },
    providerId: input.providerId,
    modelId: input.modelId,
    providerOptions: options,
  });
  const admissionSnapshot = buildProviderAdmissionSnapshot({
    capability,
    taskProfile,
    components: [
      { key: 'target', characters: estimate.components.targetCharacters, required: true },
      { key: 'halo', characters: estimate.components.haloCharacters, required: false },
      { key: 'character_graph', characters: estimate.components.graphCharacters, required: false },
      { key: 'corrections', characters: estimate.components.correctionCharacters, required: false },
      { key: 'episode_context', characters: estimate.components.sceneCharacters, required: false },
      { key: 'instructions', characters: estimate.components.staticInstructionCharacters, required: true },
      { key: 'response_schema', characters: estimate.components.schemaCharacters, required: true },
    ],
    shrinkTrace: omitted,
    estimatedInputTokens: estimate.tokens,
  });

  return {
    version: LABELING_CONTEXT_PACKET_VERSION,
    novelId: input.novelId,
    chapterId: input.chapterId,
    targetParagraphIds: [...targetParagraphIds],
    halo,
    sceneContext,
    relevantCharacterGraph,
    characterKnowledge,
    correctionMemory,
    capability,
    taskProfile,
    admissionSnapshot,
    budget: {
      ...estimate.components,
      estimatedInputTokens: estimate.tokens,
      reservedOutputTokens: maxOutputTokens,
      availableInputTokens,
      admission: admissionSnapshot.decision,
    },
    selectionTrace: {
      selectedCharacterReasons: Object.fromEntries(
        Object.entries(graphSelection.reasons)
          .filter(([id]) => relevantCharacterGraph.characters.some((character) => character.id === id))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      selectedCorrectionIds: correctionMemory.map((correction) => correction.correctionId),
      omitted,
      warnings,
    },
  };
}

export function assertLabelingContextPacketAdmitted(packet: LabelingContextPacketV2): void {
  if (packet.budget.admission === 'rejected') {
    throw new LabelingContextBudgetExceededError(
      packet.budget.estimatedInputTokens,
      packet.budget.availableInputTokens,
    );
  }
}

export function isLabelingContextPacketV2(value: unknown): value is LabelingContextPacketV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (
    body.version !== LABELING_CONTEXT_PACKET_VERSION ||
    typeof body.novelId !== 'string' ||
    typeof body.chapterId !== 'string' ||
    !Array.isArray(body.targetParagraphIds) ||
    body.targetParagraphIds.some((item) => typeof item !== 'string') ||
    !Array.isArray(body.halo) ||
    !Array.isArray(body.correctionMemory)
  ) {
    return false;
  }
  const graph = body.relevantCharacterGraph;
  const capability = body.capability;
  const budget = body.budget;
  const trace = body.selectionTrace;
  return Boolean(
    graph &&
    typeof graph === 'object' &&
    !Array.isArray(graph) &&
    Array.isArray((graph as Record<string, unknown>).characters) &&
    Array.isArray((graph as Record<string, unknown>).relations) &&
    capability &&
    typeof capability === 'object' &&
    !Array.isArray(capability) &&
    budget &&
    typeof budget === 'object' &&
    !Array.isArray(budget) &&
    trace &&
    typeof trace === 'object' &&
    !Array.isArray(trace),
  );
}

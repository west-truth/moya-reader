import type { LabelChapterSegmentsInput } from './ai';

export interface ChapterLabelingPromptPayloadOptions {
  readonly requestProfileId?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly windowId?: string;
  readonly inputRevisionId?: string;
}

function jsonOrText(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function characterPayload(
  character: NonNullable<LabelChapterSegmentsInput['knownCharacters']>[number],
): Record<string, unknown> {
  return {
    character_id: character.id,
    canonical_name: character.canonicalName,
    aliases: character.aliases,
    description: character.description,
    confidence: character.confidence,
    is_user_confirmed: character.isUserConfirmed,
  };
}

function characterGraphPayload(
  graph: NonNullable<LabelChapterSegmentsInput['characterGraph']>,
): Record<string, unknown> {
  return {
    novel_id: graph.novelId,
    characters: graph.characters.map(characterPayload),
    relations: graph.relations.map((relation) => ({
      relation_id: relation.id,
      source_character_id: relation.sourceCharacterId,
      target_character_id: relation.targetCharacterId,
      relation_label: relation.relationLabel,
      terms_used_by_source: relation.termsUsedBySource,
      terms_used_by_target: relation.termsUsedByTarget,
      confidence: relation.confidence,
      evidence: relation.evidence ?? [],
    })),
  };
}

function previousContextPayload(context: NonNullable<LabelChapterSegmentsInput['previousEpisodeContext']>) {
  return {
    version: context.version,
    chapter_id: context.chapterId,
    summary: context.summary,
    scene: context.scene,
    active_character_ids: context.activeCharacterIds,
    interlocutor_edges: context.interlocutorEdges?.map((edge) => ({
      source_character_id: edge.sourceCharacterId,
      target_character_id: edge.targetCharacterId,
      confidence: edge.confidence,
    })),
    recent_turns: context.recentTurns?.map((turn) => ({
      paragraph_id: turn.paragraphId,
      speaker_id: turn.speakerId,
      listener_ids: turn.listenerIds,
      emotion: turn.emotion,
      text: turn.text,
    })),
    unresolved: context.unresolved,
    unresolved_references: context.unresolvedReferences,
    correction_memory_cursor: context.correctionMemoryCursor,
    source_window_id: context.sourceWindowId,
    source_artifact_id: context.sourceArtifactId,
  };
}

function contextPacketPayload(packet: NonNullable<LabelChapterSegmentsInput['contextPacket']>) {
  return {
    version: packet.version,
    novel_id: packet.novelId,
    chapter_id: packet.chapterId,
    target_paragraph_ids: packet.targetParagraphIds,
    halo_paragraphs: packet.halo.map((paragraph) => ({
      paragraph_id: paragraph.paragraphId,
      index: paragraph.index,
      side: paragraph.side,
      text: paragraph.text,
      text_hash: paragraph.textHash,
    })),
    scene_context: packet.sceneContext ? previousContextPayload(packet.sceneContext) : undefined,
    relevant_character_graph: characterGraphPayload(packet.relevantCharacterGraph),
    correction_memory: packet.correctionMemory.map((correction) => ({
      correction_id: correction.correctionId,
      correction_type: correction.correctionType,
      apply_scope: correction.applyScope,
      chapter_id: correction.chapterId,
      paragraph_id: correction.paragraphId,
      segment_id: correction.segmentId,
      normalized_value: correction.normalizedValue,
      precedence: correction.precedence,
      created_at: correction.createdAt,
    })),
    capability_snapshot: {
      capability_snapshot_id: packet.capability.id,
      provider_id: packet.capability.providerId,
      model_id: packet.capability.modelId,
      requested_model_id: packet.capability.requestedModelId,
      resolved_model_version: packet.capability.resolvedModelVersion,
      source: packet.capability.source,
      freshness: packet.capability.freshness,
      count_strategy: packet.capability.countStrategy,
      context_window_tokens: packet.capability.contextWindowTokens,
      max_output_tokens: packet.capability.maxOutputTokens,
      available_input_tokens: packet.capability.availableInputTokens,
      token_count_mode: packet.capability.tokenCountMode,
      estimated_characters_per_token: packet.capability.estimatedCharactersPerToken,
      safety_factor: packet.capability.safetyFactor,
    },
    task_profile_snapshot: packet.taskProfile,
    admission_snapshot: packet.admissionSnapshot,
    budget: packet.budget,
    selection_trace: packet.selectionTrace,
  };
}

export function buildChapterLabelingPromptPayload(
  input: LabelChapterSegmentsInput,
  options: ChapterLabelingPromptPayloadOptions,
): Record<string, unknown> {
  const knownCharactersSource = input.knownCharacters?.length
    ? input.knownCharacters
    : input.characterGraph?.characters;
  const knownCharacters = knownCharactersSource?.map(characterPayload);
  const characterGraph =
    input.characterGraph && (input.characterGraph.characters.length || input.characterGraph.relations.length)
      ? characterGraphPayload(input.characterGraph)
      : undefined;
  const userCorrections = input.userCorrections?.map((correction) => ({
    correction_id: correction.id,
    chapter_id: correction.chapterId,
    paragraph_id: correction.paragraphId,
    segment_id: correction.segmentId,
    correction_type: correction.correctionType,
    before_json: jsonOrText(correction.beforeJson),
    after_json: jsonOrText(correction.afterJson),
    apply_scope: correction.applyScope,
    created_at: correction.createdAt,
  }));
  return {
    request_profile_id: options.requestProfileId,
    prompt_version: options.promptVersion,
    schema_version: options.schemaVersion,
    window_id: options.windowId ?? input.windowId ?? input.chapter.id,
    input_revision_id: options.inputRevisionId ?? input.inputRevisionId ?? input.windowId ?? input.chapter.id,
    novel_id: input.novelId,
    chapter: {
      chapter_id: input.chapter.id,
      index: input.chapter.index,
      title: input.chapter.title,
      text_hash: input.chapter.textHash,
    },
    paragraphs: input.paragraphs.map((paragraph) => ({
      paragraph_id: paragraph.id,
      index: paragraph.index,
      text: paragraph.text,
      length: paragraph.text.length,
      text_hash: paragraph.textHash,
    })),
    labeling_context_packet: input.contextPacket ? contextPacketPayload(input.contextPacket) : undefined,
    known_characters: input.contextPacket ? undefined : knownCharacters?.length ? knownCharacters : undefined,
    character_graph: input.contextPacket ? undefined : characterGraph,
    previous_episode_context: input.contextPacket
      ? undefined
      : input.previousEpisodeContext
        ? previousContextPayload(input.previousEpisodeContext)
        : undefined,
    user_corrections: input.contextPacket ? undefined : userCorrections?.length ? userCorrections : undefined,
  };
}

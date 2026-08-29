import { persistentId128 } from '@noveldesk/text-core/hash';
import type { Chapter, Paragraph, UserCorrection, VoiceProfile } from '@noveldesk/contracts';
import type { CharacterBundleChapterInput } from '../../../../../src/providers/ai';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import { normalizeTTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import { isLabelingContextPacketV2 } from '../../../../../src/providers/labeling-context-packet';
import {
  buildProviderAdmissionSnapshot,
  parseProviderAdmissionSnapshot,
  parseProviderCapabilitySnapshot,
  parseProviderTaskProfileSnapshot,
  resolveLLMCapabilitySnapshot,
  resolveProviderTaskProfile,
  resolveTTSCapabilitySnapshot,
  type ProviderAdmissionSnapshot,
  type ProviderCapabilitySnapshot,
  type ProviderTaskProfileSnapshot,
} from '../../../../../src/providers/provider-capability';
import type pg from 'pg';
import type {
  AnalysisInputRevision,
  AnalysisSourceSnapshot,
  AnalysisWindowSpec,
  CreateAnalysisInputRevision,
} from './analysis-input-contracts.js';
import {
  assertSpeakerAttributionPinnedPayload,
  type SpeakerAttributionPinnedPayloadV3,
} from '../../../../../src/providers/speaker-attribution/workflow-contract';

export interface RevisionQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface AnalysisInputRevisionRow extends pg.QueryResultRow {
  id: string;
  provider_job_id: string;
  workflow_id: string | null;
  user_id: string;
  book_id: string;
  chapter_id: string | null;
  job_type: string;
  content_revision_id: string;
  content_revision_number: number | string;
  revision_fence: number | string;
  source_object_id: string | null;
  source_raw_text_hash: string | null;
  normalized_text_hash: string;
  character_graph_revision_id: string | null;
  character_graph_fingerprint: string;
  correction_fingerprint: string;
  request_profile_id: string;
  prompt_version: string;
  schema_version: string;
  provider_id: string;
  model_id: string | null;
  provider_options_fingerprint: string;
  provider_options: unknown;
  capability_snapshot_id: string | null;
  capability_snapshot: unknown;
  task_profile_snapshot: unknown;
  admission_snapshot: unknown;
  window_spec: unknown;
  source_snapshot: unknown;
  graph_snapshot: unknown;
  corrections_snapshot: unknown;
  episode_context_snapshot: unknown;
  render_spec: unknown;
  render_spec_hash: string | null;
  voice_profile_snapshot: unknown;
  input_hash: string;
  created_at: Date | string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} is invalid`);
  return value.map(String);
}

function chapter(value: unknown): Chapter {
  const body = record(value, 'analysis chapter snapshot');
  return {
    id: stringValue(body.id, 'analysis chapter id'),
    novelId: stringValue(body.novelId, 'analysis chapter novel id'),
    index: numberValue(body.index, 'analysis chapter index'),
    title: stringValue(body.title, 'analysis chapter title'),
    normalizedText: typeof body.normalizedText === 'string' ? body.normalizedText : '',
    textHash: stringValue(body.textHash, 'analysis chapter text hash'),
    rawStartOffset: numberValue(body.rawStartOffset, 'analysis chapter raw start'),
    rawEndOffset: numberValue(body.rawEndOffset, 'analysis chapter raw end'),
    characterCount: numberValue(body.characterCount, 'analysis chapter character count'),
    paragraphCount: numberValue(body.paragraphCount, 'analysis chapter paragraph count'),
    createdAt: stringValue(body.createdAt, 'analysis chapter createdAt'),
    updatedAt: stringValue(body.updatedAt, 'analysis chapter updatedAt'),
  };
}

function paragraph(value: unknown): Paragraph {
  const body = record(value, 'analysis paragraph snapshot');
  return {
    id: stringValue(body.id, 'analysis paragraph id'),
    novelId: stringValue(body.novelId, 'analysis paragraph novel id'),
    chapterId: stringValue(body.chapterId, 'analysis paragraph chapter id'),
    index: numberValue(body.index, 'analysis paragraph index'),
    text: typeof body.text === 'string' ? body.text : '',
    startOffsetInChapter: numberValue(body.startOffsetInChapter, 'analysis paragraph start'),
    endOffsetInChapter: numberValue(body.endOffsetInChapter, 'analysis paragraph end'),
    textHash: stringValue(body.textHash, 'analysis paragraph text hash'),
  };
}

function bundleChapter(value: unknown): CharacterBundleChapterInput {
  const body = record(value, 'analysis bundle chapter');
  if (!Array.isArray(body.paragraphs)) throw new Error('analysis bundle chapter paragraphs are invalid');
  return { chapter: chapter(body.chapter), paragraphs: body.paragraphs.map(paragraph) };
}

function sourceSnapshot(value: unknown, bookId: string): AnalysisSourceSnapshot {
  const body = record(value, 'analysis source snapshot');
  const kind = stringValue(body.kind, 'analysis source snapshot kind');
  if (kind === 'character_bundle') {
    if (!Array.isArray(body.chapters)) throw new Error('analysis character bundle snapshot is invalid');
    return {
      kind,
      bundleId: stringValue(body.bundleId, 'analysis character bundle id'),
      chapters: body.chapters.map(bundleChapter),
      previousBundleSummary: typeof body.previousBundleSummary === 'string' ? body.previousBundleSummary : undefined,
    };
  }
  if (kind === 'character_graph_merge') {
    record(body.discoveredGraph, 'analysis discovered graph');
    return {
      kind,
      discoveredGraph: normalizeCharacterGraphSnapshot(body.discoveredGraph, bookId),
      sourceContext:
        body.sourceContext === undefined
          ? undefined
          : (() => {
              const context = record(body.sourceContext, 'analysis graph source context');
              const chapterIds =
                context.chapterIds === undefined
                  ? undefined
                  : stringArray(context.chapterIds, 'analysis graph source chapter ids');
              return {
                bundleId: optionalString(context.bundleId),
                chapterIds,
                summary: optionalString(context.summary),
              };
            })(),
    };
  }
  if (kind === 'chapter_labeling') {
    record(body.chapter, 'analysis chapter snapshot');
    if (!Array.isArray(body.paragraphs)) throw new Error('analysis chapter paragraphs snapshot is invalid');
    if (body.contextPacket !== undefined && !isLabelingContextPacketV2(body.contextPacket)) {
      throw new Error('analysis labeling context packet is invalid');
    }
    return {
      kind,
      chapter: chapter(body.chapter),
      paragraphs: body.paragraphs.map(paragraph),
      coversFullChapter: body.coversFullChapter === true,
      finalWindowForChapter: body.finalWindowForChapter === true,
      repairRequestProfile:
        body.repairRequestProfile === undefined
          ? undefined
          : (() => {
              const profile = record(body.repairRequestProfile, 'analysis repair request profile');
              return {
                id: stringValue(profile.id, 'analysis repair request profile id'),
                promptVersion: stringValue(profile.promptVersion, 'analysis repair prompt version'),
                schemaVersion: stringValue(profile.schemaVersion, 'analysis repair schema version'),
              };
            })(),
      contextPacket: body.contextPacket,
    };
  }
  if (kind === 'chapter_label_repair') {
    record(body.chapter, 'analysis repair chapter snapshot');
    if (!Array.isArray(body.paragraphs) || !Array.isArray(body.repairIssues)) {
      throw new Error('analysis chapter repair snapshot is invalid');
    }
    if (body.contextPacket !== undefined && !isLabelingContextPacketV2(body.contextPacket)) {
      throw new Error('analysis repair context packet is invalid');
    }
    return {
      kind,
      parentInputRevisionId: stringValue(body.parentInputRevisionId, 'analysis repair parent revision id'),
      parentProviderJobId: stringValue(body.parentProviderJobId, 'analysis repair parent job id'),
      candidateArtifactId: stringValue(body.candidateArtifactId, 'analysis repair candidate artifact id'),
      candidateOutputHash: stringValue(body.candidateOutputHash, 'analysis repair candidate output hash'),
      repairInputFingerprint: stringValue(body.repairInputFingerprint, 'analysis repair input fingerprint'),
      repairIssues: body.repairIssues.map((item) => {
        const issue = record(item, 'analysis repair issue');
        const severity = stringValue(issue.severity, 'analysis repair issue severity');
        if (severity !== 'error' && severity !== 'warning') {
          throw new Error('analysis repair issue severity is invalid');
        }
        return {
          severity,
          code: stringValue(issue.code, 'analysis repair issue code'),
          message: stringValue(issue.message, 'analysis repair issue message'),
          segmentId: optionalString(issue.segmentId),
          paragraphId: optionalString(issue.paragraphId),
        };
      }),
      chapter: chapter(body.chapter),
      paragraphs: body.paragraphs.map(paragraph),
      coversFullChapter: body.coversFullChapter === true,
      finalWindowForChapter: body.finalWindowForChapter === true,
      contextPacket: body.contextPacket,
    };
  }
  if (kind === 'speaker_attribution_v3') {
    const payload = body as unknown as SpeakerAttributionPinnedPayloadV3;
    assertSpeakerAttributionPinnedPayload(payload);
    if (
      !Array.isArray(payload.canonicalSource.paragraphs) ||
      !Array.isArray(payload.canonicalSource.sourceParagraphs)
    ) {
      throw new Error('analysis compact speaker source paragraphs are invalid');
    }
    return {
      ...payload,
      kind,
      coversFullChapter: body.coversFullChapter === true,
      finalWindowForChapter: body.finalWindowForChapter === true,
      canonicalSource: {
        ...payload.canonicalSource,
        chapter: chapter(payload.canonicalSource.chapter),
        paragraphs: payload.canonicalSource.paragraphs.map(paragraph),
      },
    };
  }
  if (kind === 'tts_synthesis') {
    if (!Array.isArray(body.segmentIds) || typeof body.text !== 'string') {
      throw new Error('analysis TTS source snapshot is invalid');
    }
    return {
      kind,
      chapterId: stringValue(body.chapterId, 'analysis TTS chapter id'),
      segmentIds: body.segmentIds.filter((item): item is string => typeof item === 'string'),
      text: body.text,
      segmentTextHashes: Object.fromEntries(
        Object.entries(record(body.segmentTextHashes, 'analysis TTS segment hashes')).map(([key, item]) => [
          key,
          stringValue(item, `analysis TTS segment hash ${key}`),
        ]),
      ),
    };
  }
  throw new Error(`Unsupported analysis source snapshot kind: ${kind}`);
}

function windowSpec(value: unknown): AnalysisWindowSpec {
  const body = record(value, 'analysis window spec');
  if (
    !Array.isArray(body.chapterAnchors) ||
    !Array.isArray(body.paragraphAnchors) ||
    (body.contextParagraphAnchors !== undefined && !Array.isArray(body.contextParagraphAnchors))
  ) {
    throw new Error('analysis window spec anchors are invalid');
  }
  return {
    windowId: stringValue(body.windowId, 'analysis window id'),
    sequence: numberValue(body.sequence, 'analysis window sequence'),
    chapterAnchors: body.chapterAnchors.map((item) => {
      const anchor = record(item, 'analysis chapter anchor');
      return {
        chapterId: stringValue(anchor.chapterId, 'analysis chapter anchor id'),
        chapterIndex: numberValue(anchor.chapterIndex, 'analysis chapter anchor index'),
        textHash: stringValue(anchor.textHash, 'analysis chapter anchor text hash'),
      };
    }),
    paragraphAnchors: body.paragraphAnchors.map((item) => {
      const anchor = record(item, 'analysis paragraph anchor');
      return {
        paragraphId: stringValue(anchor.paragraphId, 'analysis paragraph anchor id'),
        chapterId: stringValue(anchor.chapterId, 'analysis paragraph anchor chapter id'),
        paragraphIndex: numberValue(anchor.paragraphIndex, 'analysis paragraph anchor index'),
        textHash: stringValue(anchor.textHash, 'analysis paragraph anchor text hash'),
      };
    }),
    contextParagraphAnchors: Array.isArray(body.contextParagraphAnchors)
      ? body.contextParagraphAnchors.map((item) => {
          const anchor = record(item, 'analysis context paragraph anchor');
          return {
            paragraphId: stringValue(anchor.paragraphId, 'analysis context paragraph anchor id'),
            chapterId: stringValue(anchor.chapterId, 'analysis context paragraph anchor chapter id'),
            paragraphIndex: numberValue(anchor.paragraphIndex, 'analysis context paragraph anchor index'),
            textHash: stringValue(anchor.textHash, 'analysis context paragraph anchor text hash'),
          };
        })
      : undefined,
    coversFullChapter: body.coversFullChapter === true,
    finalWindowForChapter: body.finalWindowForChapter === true,
  };
}

function corrections(value: unknown): readonly UserCorrection[] {
  if (!Array.isArray(value)) throw new Error('analysis corrections snapshot is invalid');
  return value.map((item) => {
    const body = record(item, 'analysis correction snapshot');
    const correctionType = stringValue(body.correctionType, 'analysis correction type');
    const applyScope = stringValue(body.applyScope, 'analysis correction scope');
    if (!['speaker', 'listener', 'emotion', 'prosody', 'segment_type', 'voice', 'note'].includes(correctionType)) {
      throw new Error('analysis correction type is invalid');
    }
    if (!['segment', 'chapter', 'future_pattern', 'global'].includes(applyScope)) {
      throw new Error('analysis correction scope is invalid');
    }
    return {
      id: stringValue(body.id, 'analysis correction id'),
      novelId: stringValue(body.novelId, 'analysis correction novel id'),
      chapterId: stringValue(body.chapterId, 'analysis correction chapter id'),
      paragraphId: optionalString(body.paragraphId),
      segmentId: optionalString(body.segmentId),
      correctionType: correctionType as UserCorrection['correctionType'],
      beforeJson: optionalString(body.beforeJson),
      afterJson: stringValue(body.afterJson, 'analysis correction afterJson'),
      applyScope: applyScope as UserCorrection['applyScope'],
      createdAt: stringValue(body.createdAt, 'analysis correction createdAt'),
    };
  });
}

function voiceProfile(value: unknown): VoiceProfile | undefined {
  if (value === null || value === undefined) return undefined;
  const body = record(value, 'analysis voice profile snapshot');
  const role = stringValue(body.role, 'analysis voice profile role');
  if (!['narrator', 'character', 'system', 'unknown'].includes(role)) {
    throw new Error('analysis voice profile role is invalid');
  }
  return {
    id: stringValue(body.id, 'analysis voice profile id'),
    novelId: stringValue(body.novelId, 'analysis voice profile novel id'),
    characterId: optionalString(body.characterId),
    role: role as VoiceProfile['role'],
    providerId: stringValue(body.providerId, 'analysis voice profile provider id'),
    providerVoiceId: stringValue(body.providerVoiceId, 'analysis voice profile provider voice id'),
    providerModel: optionalString(body.providerModel),
    label: stringValue(body.label, 'analysis voice profile label'),
    language: optionalString(body.language),
    tone: optionalString(body.tone),
    speed: finiteNumber(body.speed, 'analysis voice profile speed'),
    pitch: body.pitch === undefined ? undefined : finiteNumber(body.pitch, 'analysis voice profile pitch'),
    emotionPolicy: optionalString(body.emotionPolicy),
    providerOptions:
      body.providerOptions === undefined ? {} : record(body.providerOptions, 'analysis voice profile provider options'),
    isUserSelected: body.isUserSelected === true,
    createdAt: optionalString(body.createdAt),
    updatedAt: optionalString(body.updatedAt),
  };
}

function episodeContext(value: unknown): AnalysisInputRevision['episodeContextSnapshot'] {
  if (value === null || value === undefined) return undefined;
  const body = record(value, 'analysis episode context snapshot');
  const interlocutorEdges = Array.isArray(body.interlocutorEdges)
    ? body.interlocutorEdges.flatMap((item) => {
        const edge = record(item, 'analysis episode interlocutor edge');
        return [
          {
            sourceCharacterId: stringValue(edge.sourceCharacterId, 'analysis episode edge source'),
            targetCharacterId: stringValue(edge.targetCharacterId, 'analysis episode edge target'),
          },
        ];
      })
    : undefined;
  const recentTurns = Array.isArray(body.recentTurns)
    ? body.recentTurns.map((item) => {
        const turn = record(item, 'analysis episode recent turn');
        return {
          paragraphId: stringValue(turn.paragraphId, 'analysis episode recent turn paragraph'),
          speakerId: stringValue(turn.speakerId, 'analysis episode recent turn speaker'),
          listenerIds: stringArray(turn.listenerIds, 'analysis episode recent turn listeners'),
          emotion: stringValue(turn.emotion, 'analysis episode recent turn emotion'),
          text: stringValue(turn.text, 'analysis episode recent turn text'),
        };
      })
    : undefined;
  return {
    chapterId: stringValue(body.chapterId, 'analysis episode context chapter id'),
    summary: stringValue(body.summary, 'analysis episode context summary'),
    activeCharacterIds: stringArray(body.activeCharacterIds, 'analysis episode active characters'),
    unresolved: stringArray(body.unresolved, 'analysis episode unresolved items'),
    version: body.version === 'episode-context-v2' ? body.version : undefined,
    scene: optionalString(body.scene),
    interlocutorEdges,
    recentTurns,
    unresolvedReferences: Array.isArray(body.unresolvedReferences)
      ? stringArray(body.unresolvedReferences, 'analysis episode unresolved references')
      : undefined,
    correctionMemoryCursor: optionalString(body.correctionMemoryCursor),
    sourceWindowId: optionalString(body.sourceWindowId),
    sourceArtifactId: optionalString(body.sourceArtifactId),
  };
}

interface CapabilityEnvelopeInput {
  readonly jobType: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly requestProfile: AnalysisInputRevision['requestProfile'];
  readonly sourceSnapshot: AnalysisSourceSnapshot;
  readonly capabilitySnapshot?: ProviderCapabilitySnapshot;
  readonly taskProfileSnapshot?: ProviderTaskProfileSnapshot;
  readonly admissionSnapshot?: ProviderAdmissionSnapshot;
}

function contextPacketFromSource(source: AnalysisSourceSnapshot) {
  return source.kind === 'chapter_labeling' || source.kind === 'chapter_label_repair'
    ? source.contextPacket
    : undefined;
}

function capabilityEnvelope(input: CapabilityEnvelopeInput): {
  capabilitySnapshot: ProviderCapabilitySnapshot;
  taskProfileSnapshot: ProviderTaskProfileSnapshot;
  admissionSnapshot?: ProviderAdmissionSnapshot;
} {
  const contextPacket = contextPacketFromSource(input.sourceSnapshot);
  const contextRecord = contextPacket as unknown as
    | {
        capability?: unknown;
        taskProfile?: unknown;
        admissionSnapshot?: unknown;
      }
    | undefined;
  const taskProfileSnapshot =
    input.taskProfileSnapshot ??
    (contextRecord?.taskProfile ? parseProviderTaskProfileSnapshot(contextRecord.taskProfile) : undefined) ??
    resolveProviderTaskProfile({
      jobType: input.jobType,
      requestProfile: input.requestProfile,
      providerId: input.providerId,
      modelId: input.modelId,
      providerOptions: input.providerOptions,
    });
  const capabilitySnapshot =
    input.capabilitySnapshot ??
    (contextRecord?.capability &&
    (contextRecord.capability as { version?: unknown }).version === 'provider-capability-v1'
      ? parseProviderCapabilitySnapshot(contextRecord.capability)
      : undefined) ??
    (input.jobType === 'tts_synthesis' || input.jobType === 'tts_prefetch'
      ? resolveTTSCapabilitySnapshot({
          providerId: input.providerId,
          modelId: input.modelId,
          providerOptions: input.providerOptions,
        })
      : resolveLLMCapabilitySnapshot({
          providerId: input.providerId,
          modelId: input.modelId,
          providerOptions: input.providerOptions,
        }));
  const admissionSnapshot =
    input.admissionSnapshot ??
    (contextRecord?.admissionSnapshot ? parseProviderAdmissionSnapshot(contextRecord.admissionSnapshot) : undefined) ??
    (capabilitySnapshot.kind === 'llm'
      ? buildProviderAdmissionSnapshot({
          capability: capabilitySnapshot,
          taskProfile: taskProfileSnapshot,
          components:
            input.sourceSnapshot.kind === 'speaker_attribution_v3'
              ? [
                  {
                    key: 'largest_speaker_packet',
                    characters: Math.max(
                      1,
                      ...input.sourceSnapshot.units.map((unit) => JSON.stringify(unit.packet).length + 3_000),
                    ),
                    required: true,
                  },
                ]
              : [
                  {
                    key: 'source_snapshot',
                    characters: JSON.stringify(input.sourceSnapshot).length,
                    required: true,
                  },
                ],
          reservedOutputTokens:
            input.sourceSnapshot.kind === 'speaker_attribution_v3'
              ? Math.max(1, ...input.sourceSnapshot.units.map((unit) => unit.outputBudget.requestedOutputCap))
              : undefined,
        })
      : undefined);
  return { capabilitySnapshot, taskProfileSnapshot, admissionSnapshot };
}

function mapRow(row: AnalysisInputRevisionRow): AnalysisInputRevision {
  const options = record(row.provider_options, 'analysis provider options');
  const parsedSource = sourceSnapshot(row.source_snapshot, row.book_id);
  const requestProfile = {
    id: row.request_profile_id,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
  };
  const envelope = capabilityEnvelope({
    jobType: row.job_type,
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    providerOptions: options,
    requestProfile,
    sourceSnapshot: parsedSource,
    capabilitySnapshot:
      row.capability_snapshot === null || row.capability_snapshot === undefined
        ? undefined
        : parseProviderCapabilitySnapshot(row.capability_snapshot),
    taskProfileSnapshot:
      row.task_profile_snapshot === null || row.task_profile_snapshot === undefined
        ? undefined
        : parseProviderTaskProfileSnapshot(row.task_profile_snapshot),
    admissionSnapshot:
      row.admission_snapshot === null || row.admission_snapshot === undefined
        ? undefined
        : parseProviderAdmissionSnapshot(row.admission_snapshot),
  });
  return {
    id: row.id,
    providerJobId: row.provider_job_id,
    workflowId: row.workflow_id ?? undefined,
    userId: row.user_id,
    bookId: row.book_id,
    chapterId: row.chapter_id ?? undefined,
    jobType: row.job_type,
    contentRevisionId: row.content_revision_id,
    contentRevisionNumber: numberValue(row.content_revision_number, 'analysis content revision number'),
    revisionFence: numberValue(row.revision_fence, 'analysis revision fence'),
    sourceObjectId: row.source_object_id ?? undefined,
    sourceRawTextHash: row.source_raw_text_hash ?? undefined,
    normalizedTextHash: row.normalized_text_hash,
    characterGraphRevisionId: row.character_graph_revision_id ?? undefined,
    characterGraphFingerprint: row.character_graph_fingerprint,
    correctionFingerprint: row.correction_fingerprint,
    requestProfile,
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    providerOptionsFingerprint: row.provider_options_fingerprint,
    providerOptions: options,
    ...envelope,
    windowSpec: windowSpec(row.window_spec),
    sourceSnapshot: parsedSource,
    graphSnapshot: normalizeCharacterGraphSnapshot(row.graph_snapshot, row.book_id, { trustUserConfirmed: true }),
    correctionsSnapshot: corrections(row.corrections_snapshot),
    episodeContextSnapshot: episodeContext(row.episode_context_snapshot),
    renderSpec: row.render_spec === null ? undefined : normalizeTTSRenderSpec(row.render_spec),
    renderSpecHash: row.render_spec_hash ?? undefined,
    voiceProfileSnapshot: voiceProfile(row.voice_profile_snapshot),
    inputHash: row.input_hash,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const revisionColumns = `
  id, provider_job_id, workflow_id, user_id, book_id, chapter_id, job_type,
  content_revision_id, content_revision_number, revision_fence, source_object_id,
  source_raw_text_hash, normalized_text_hash, character_graph_revision_id,
  character_graph_fingerprint, correction_fingerprint, request_profile_id,
  prompt_version, schema_version, provider_id, model_id, provider_options_fingerprint,
  provider_options, window_spec, source_snapshot, graph_snapshot, corrections_snapshot,
  episode_context_snapshot, render_spec, render_spec_hash, voice_profile_snapshot,
  capability_snapshot_id, capability_snapshot, task_profile_snapshot, admission_snapshot,
  input_hash, created_at
`;

export async function insertAnalysisInputRevision(
  db: RevisionQueryable,
  input: CreateAnalysisInputRevision,
): Promise<AnalysisInputRevision> {
  const id = persistentId128('analysis_input_revision', [input.providerJobId, input.inputHash]);
  const envelope = capabilityEnvelope(input);
  await db.query(
    `insert into provider_capability_snapshots
     (id, user_id, capability_kind, provider_id, requested_model_id, resolved_model_version,
      source, freshness, fingerprint, payload, verified_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (id) do nothing`,
    [
      envelope.capabilitySnapshot.id,
      input.userId,
      envelope.capabilitySnapshot.kind,
      envelope.capabilitySnapshot.providerId,
      envelope.capabilitySnapshot.requestedModelId,
      envelope.capabilitySnapshot.resolvedModelVersion ?? null,
      envelope.capabilitySnapshot.source,
      envelope.capabilitySnapshot.freshness,
      envelope.capabilitySnapshot.fingerprint,
      JSON.stringify(envelope.capabilitySnapshot),
      envelope.capabilitySnapshot.verifiedAt,
      envelope.capabilitySnapshot.expiresAt ?? null,
    ],
  );
  const inserted = await db.query<AnalysisInputRevisionRow>(
    `
      insert into analysis_input_revisions (
        id, provider_job_id, workflow_id, user_id, book_id, chapter_id, job_type,
        content_revision_id, content_revision_number, revision_fence, source_object_id,
        source_raw_text_hash, normalized_text_hash, character_graph_revision_id,
        character_graph_fingerprint, correction_fingerprint, request_profile_id,
        prompt_version, schema_version, provider_id, model_id, provider_options_fingerprint,
        provider_options, window_spec, source_snapshot, graph_snapshot, corrections_snapshot,
        episode_context_snapshot, render_spec, render_spec_hash, voice_profile_snapshot,
        capability_snapshot_id, capability_snapshot, task_profile_snapshot, admission_snapshot,
        input_hash, created_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
        $32, $33, $34, $35, $36, now()
      )
      on conflict (provider_job_id) do nothing
      returning ${revisionColumns}
    `,
    [
      id,
      input.providerJobId,
      input.workflowId ?? null,
      input.userId,
      input.bookId,
      input.chapterId ?? null,
      input.jobType,
      input.contentRevisionId,
      input.contentRevisionNumber,
      input.revisionFence,
      input.sourceObjectId ?? null,
      input.sourceRawTextHash ?? null,
      input.normalizedTextHash,
      input.characterGraphRevisionId ?? null,
      input.characterGraphFingerprint,
      input.correctionFingerprint,
      input.requestProfile.id,
      input.requestProfile.promptVersion,
      input.requestProfile.schemaVersion,
      input.providerId,
      input.modelId ?? null,
      input.providerOptionsFingerprint,
      JSON.stringify(input.providerOptions),
      JSON.stringify(input.windowSpec),
      JSON.stringify(input.sourceSnapshot),
      JSON.stringify(input.graphSnapshot),
      JSON.stringify(input.correctionsSnapshot),
      input.episodeContextSnapshot ? JSON.stringify(input.episodeContextSnapshot) : null,
      input.renderSpec ? JSON.stringify(input.renderSpec) : null,
      input.renderSpecHash ?? null,
      input.voiceProfileSnapshot ? JSON.stringify(input.voiceProfileSnapshot) : null,
      envelope.capabilitySnapshot.id,
      JSON.stringify(envelope.capabilitySnapshot),
      JSON.stringify(envelope.taskProfileSnapshot),
      envelope.admissionSnapshot ? JSON.stringify(envelope.admissionSnapshot) : null,
      input.inputHash,
    ],
  );
  const revision = inserted.rows[0]
    ? mapRow(inserted.rows[0])
    : await loadAnalysisInputRevisionForJob(db, input.providerJobId);
  if (!revision || revision.inputHash !== input.inputHash) {
    throw new Error(`Provider job input revision conflict: ${input.providerJobId}`);
  }
  const linked = await db.query(
    `
      update provider_jobs
      set analysis_input_revision_id = $2, capability_snapshot_id = $3, updated_at = now()
      where id = $1
        and (analysis_input_revision_id is null or analysis_input_revision_id = $2)
    `,
    [input.providerJobId, revision.id, envelope.capabilitySnapshot.id],
  );
  if (linked.rowCount !== undefined && linked.rowCount === 0) {
    throw new Error(`Provider job could not pin input revision: ${input.providerJobId}`);
  }
  return revision;
}

export async function loadAnalysisInputRevisionForJob(
  db: RevisionQueryable,
  providerJobId: string,
): Promise<AnalysisInputRevision | undefined> {
  const result = await db.query<AnalysisInputRevisionRow>(
    `select ${revisionColumns} from analysis_input_revisions where provider_job_id = $1`,
    [providerJobId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function loadAnalysisInputRevision(
  db: RevisionQueryable,
  revisionId: string,
): Promise<AnalysisInputRevision | undefined> {
  const result = await db.query<AnalysisInputRevisionRow>(
    `select ${revisionColumns} from analysis_input_revisions where id = $1`,
    [revisionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

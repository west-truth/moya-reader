import { characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { providerOptionsIntegrityHash } from '@noveldesk/text-core/identity/provider';
import type {
  BookAIWorkflowBundleWindow,
  BookAIWorkflowLabelingWindow,
  BookAIWorkflowPlan,
} from '../../../../../src/providers/book-ai-workflow-plan';
import type { CharacterGraph, MergeCharacterGraphInput } from '../../../../../src/providers/ai';
import {
  assertLabelingContextPacketAdmitted,
  buildLabelingContextPacket,
  type LabelingContextPacketV2,
} from '../../../../../src/providers/labeling-context-packet';
import { resolveChapterLabelRepairRequestProfile } from '../../../../../src/providers/chapter-label-repair-request-profile';
import type { ProviderJobRow, ProviderRequestProfile } from '../provider-jobs/contracts.js';
import {
  loadBundleChapters,
  loadChapter,
  loadParagraphContextHalo,
  loadParagraphs,
} from '../provider-jobs/job-data-loader.js';
import type {
  AnalysisInputRevision,
  AnalysisWindowSpec,
  AnalysisStagingArtifact,
  SpeakerAttributionSourceSnapshot,
} from './analysis-input-contracts.js';
import type { ChapterLabelingValidationIssue } from '../../../../../src/providers/chapter-labeling-validator';
import { insertAnalysisInputRevision, type RevisionQueryable } from './analysis-input-repository.js';
import { loadPreviousWorkflowEpisodeContext } from './episode-context-repository.js';
import type { BookAIWorkflowRow } from './workflow-contracts.js';
import { loadPinnedCorrections, lockBookRevisionState, pinParagraphText } from './revision-snapshot-repository.js';
import { loadCharacterGraphKnowledgeV2 } from '../character-graph-v2-service.js';

async function workflowRevisionState(db: RevisionQueryable, workflow: BookAIWorkflowRow) {
  const state = await lockBookRevisionState(db, workflow.user_id, workflow.book_id);
  if (!state) throw new Error(`Book not found for workflow: ${workflow.book_id}`);
  if (
    state.contentRevisionId !== workflow.content_revision_id ||
    state.revisionFence !== Number(workflow.revision_fence)
  ) {
    throw new Error(`Workflow revision fence is stale: ${workflow.id}`);
  }
  return state;
}

function requestFields(profile: ProviderRequestProfile) {
  return { id: profile.id, promptVersion: profile.promptVersion, schemaVersion: profile.schemaVersion };
}

function paragraphAnchors(
  paragraphs: readonly { id: string; chapterId: string; index: number; textHash: string }[],
): AnalysisWindowSpec['paragraphAnchors'] {
  return paragraphs.map((paragraph) => ({
    paragraphId: paragraph.id,
    chapterId: paragraph.chapterId,
    paragraphIndex: paragraph.index,
    textHash: paragraph.textHash,
  }));
}

function contextHaloRadius(providerOptions: Readonly<Record<string, unknown>>): number {
  const value = providerOptions.contextHaloParagraphs;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 2;
  return Number.isFinite(parsed) ? Math.min(8, Math.max(0, Math.floor(parsed))) : 2;
}

export async function pinCharacterBundleAnalysisInput(
  db: RevisionQueryable,
  input: {
    readonly workflow: BookAIWorkflowRow;
    readonly job: ProviderJobRow;
    readonly window: BookAIWorkflowBundleWindow;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly requestProfile: ProviderRequestProfile;
    readonly previousBundleSummary?: string;
  },
): Promise<AnalysisInputRevision> {
  const state = await workflowRevisionState(db, input.workflow);
  const loadedChapters = await loadBundleChapters(db, input.job, input.window.chapterIds);
  const chapters = loadedChapters.map((item) => ({
    chapter: item.chapter,
    paragraphs: item.paragraphs.map(pinParagraphText),
  }));
  const corrections = await loadPinnedCorrections(db, state);
  const windowSpec: AnalysisWindowSpec = {
    windowId: input.window.id,
    sequence: input.window.sequence,
    chapterAnchors: chapters.map((item) => ({
      chapterId: item.chapter.id,
      chapterIndex: item.chapter.index,
      textHash: item.chapter.textHash,
    })),
    paragraphAnchors: paragraphAnchors(chapters.flatMap((item) => item.paragraphs)),
  };
  return insertAnalysisInputRevision(db, {
    providerJobId: input.job.id,
    workflowId: input.workflow.id,
    userId: input.workflow.user_id,
    bookId: input.workflow.book_id,
    jobType: input.job.job_type,
    contentRevisionId: state.contentRevisionId,
    contentRevisionNumber: state.contentRevisionNumber,
    revisionFence: state.revisionFence,
    sourceObjectId: state.sourceObjectId,
    sourceRawTextHash: state.sourceRawTextHash,
    normalizedTextHash: state.normalizedTextHash,
    characterGraphRevisionId: state.graphRevisionId,
    characterGraphFingerprint: state.graphFingerprint,
    correctionFingerprint: corrections.fingerprint,
    requestProfile: requestFields(input.requestProfile),
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptionsFingerprint: providerOptionsIntegrityHash(input.providerOptions),
    providerOptions: input.providerOptions,
    windowSpec,
    sourceSnapshot: {
      kind: 'character_bundle',
      bundleId: input.window.bundleId,
      chapters,
      previousBundleSummary: input.previousBundleSummary,
    },
    graphSnapshot: state.graphSnapshot,
    correctionsSnapshot: corrections.corrections,
    inputHash: input.job.input_hash,
  });
}

export async function pinCharacterGraphMergeInput(
  db: RevisionQueryable,
  input: {
    readonly workflow: BookAIWorkflowRow;
    readonly job: ProviderJobRow;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly requestProfile: ProviderRequestProfile;
    readonly discoveredGraph: CharacterGraph;
    readonly sourceContext?: MergeCharacterGraphInput['sourceContext'];
    readonly sourceChapterIds: readonly string[];
  },
): Promise<AnalysisInputRevision> {
  const state = await workflowRevisionState(db, input.workflow);
  const corrections = await loadPinnedCorrections(db, state);
  const chapterRows = input.sourceChapterIds.length
    ? await db.query<{ id: string; chapter_index: number | string; text_hash: string }>(
        `
          select id, chapter_index, text_hash
          from chapters
          where book_id = $1 and id = any($2::text[])
          order by chapter_index
        `,
        [input.workflow.book_id, input.sourceChapterIds],
      )
    : { rows: [] };
  return insertAnalysisInputRevision(db, {
    providerJobId: input.job.id,
    workflowId: input.workflow.id,
    userId: input.workflow.user_id,
    bookId: input.workflow.book_id,
    jobType: input.job.job_type,
    contentRevisionId: state.contentRevisionId,
    contentRevisionNumber: state.contentRevisionNumber,
    revisionFence: state.revisionFence,
    sourceObjectId: state.sourceObjectId,
    sourceRawTextHash: state.sourceRawTextHash,
    normalizedTextHash: state.normalizedTextHash,
    characterGraphRevisionId: state.graphRevisionId,
    characterGraphFingerprint: state.graphFingerprint,
    correctionFingerprint: corrections.fingerprint,
    requestProfile: requestFields(input.requestProfile),
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptionsFingerprint: providerOptionsIntegrityHash(input.providerOptions),
    providerOptions: input.providerOptions,
    windowSpec: {
      windowId: 'character_graph_merge',
      sequence: 0,
      chapterAnchors: chapterRows.rows.map((row) => ({
        chapterId: row.id,
        chapterIndex: Number(row.chapter_index),
        textHash: row.text_hash,
      })),
      paragraphAnchors: [],
    },
    sourceSnapshot: {
      kind: 'character_graph_merge',
      discoveredGraph: input.discoveredGraph,
      sourceContext: input.sourceContext,
    },
    graphSnapshot: state.graphSnapshot,
    correctionsSnapshot: corrections.corrections,
    inputHash: input.job.input_hash,
  });
}

export async function pinChapterLabelingInput(
  db: RevisionQueryable,
  input: {
    readonly workflow: BookAIWorkflowRow;
    readonly job: ProviderJobRow;
    readonly plan: BookAIWorkflowPlan;
    readonly window: BookAIWorkflowLabelingWindow;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly requestProfile: ProviderRequestProfile;
    readonly contextPacket?: LabelingContextPacketV2;
  },
): Promise<AnalysisInputRevision> {
  const state = await workflowRevisionState(db, input.workflow);
  const chapter = await loadChapter(db, input.job);
  const paragraphs = (await loadParagraphs(db, chapter.id, input.window.paragraphIds)).map(pinParagraphText);
  const chapterPlan = input.plan.labelingChapters.find((item) => item.chapterId === chapter.id);
  const coversFullChapter = (chapterPlan?.windows.length ?? 1) === 1;
  const finalWindowForChapter = chapterPlan?.windows.at(-1)?.id === input.window.id;
  const previousEpisodeContext = await loadPreviousWorkflowEpisodeContext(db, {
    workflowId: input.workflow.id,
    bookId: input.workflow.book_id,
    chapterId: chapter.id,
    chapterIndex: chapter.index,
    windowSequence: input.window.sequence,
  });
  const corrections = await loadPinnedCorrections(db, state, chapter.id);
  const repairRequestProfile = resolveChapterLabelRepairRequestProfile(input.providerOptions);
  const haloParagraphs = input.contextPacket
    ? []
    : (
        await loadParagraphContextHalo(
          db,
          chapter.id,
          input.window.startParagraphIndex,
          input.window.endParagraphIndex,
          contextHaloRadius(input.providerOptions),
        )
      ).map(pinParagraphText);
  const contextPacket =
    input.contextPacket ??
    buildLabelingContextPacket({
      novelId: input.workflow.book_id,
      chapterId: chapter.id,
      targetParagraphs: paragraphs,
      haloParagraphs,
      characterGraph: state.graphSnapshot,
      characterGraphKnowledge: await loadCharacterGraphKnowledgeV2(db, input.workflow.book_id, state.graphSnapshot),
      chapterIndex: chapter.index,
      previousEpisodeContext,
      corrections: corrections.corrections,
      providerId: input.job.provider_id,
      modelId: input.job.model_id ?? undefined,
      providerOptions: input.providerOptions,
      schemaCharacters: input.requestProfile.responseSchema
        ? JSON.stringify(input.requestProfile.responseSchema).length
        : 0,
    });
  assertLabelingContextPacketAdmitted(contextPacket);
  return insertAnalysisInputRevision(db, {
    providerJobId: input.job.id,
    workflowId: input.workflow.id,
    userId: input.workflow.user_id,
    bookId: input.workflow.book_id,
    chapterId: chapter.id,
    jobType: input.job.job_type,
    contentRevisionId: state.contentRevisionId,
    contentRevisionNumber: state.contentRevisionNumber,
    revisionFence: state.revisionFence,
    sourceObjectId: state.sourceObjectId,
    sourceRawTextHash: state.sourceRawTextHash,
    normalizedTextHash: state.normalizedTextHash,
    characterGraphRevisionId: state.graphRevisionId,
    characterGraphFingerprint: characterGraphIntegrityHash(state.graphSnapshot),
    correctionFingerprint: corrections.fingerprint,
    requestProfile: requestFields(input.requestProfile),
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptionsFingerprint: providerOptionsIntegrityHash(input.providerOptions),
    providerOptions: input.providerOptions,
    windowSpec: {
      windowId: input.window.id,
      sequence: input.window.sequence,
      chapterAnchors: [{ chapterId: chapter.id, chapterIndex: chapter.index, textHash: chapter.textHash }],
      paragraphAnchors: paragraphAnchors(paragraphs),
      contextParagraphAnchors: contextPacket.halo.map((paragraph) => ({
        paragraphId: paragraph.paragraphId,
        chapterId: chapter.id,
        paragraphIndex: paragraph.index,
        textHash: paragraph.textHash,
      })),
      coversFullChapter,
      finalWindowForChapter,
    },
    sourceSnapshot: {
      kind: 'chapter_labeling',
      chapter,
      paragraphs,
      coversFullChapter,
      finalWindowForChapter,
      repairRequestProfile: requestFields(repairRequestProfile),
      contextPacket,
    },
    graphSnapshot: state.graphSnapshot,
    correctionsSnapshot: corrections.corrections,
    episodeContextSnapshot: previousEpisodeContext,
    inputHash: input.job.input_hash,
  });
}

export async function pinSpeakerAttributionInput(
  db: RevisionQueryable,
  input: {
    readonly workflow: BookAIWorkflowRow;
    readonly job: ProviderJobRow;
    readonly window: BookAIWorkflowLabelingWindow;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly requestProfile: ProviderRequestProfile;
    readonly sourceSnapshot: SpeakerAttributionSourceSnapshot;
    readonly previousEpisodeContext?: AnalysisInputRevision['episodeContextSnapshot'];
  },
): Promise<AnalysisInputRevision> {
  const state = await workflowRevisionState(db, input.workflow);
  const corrections = await loadPinnedCorrections(db, state, input.sourceSnapshot.canonicalSource.chapter.id);
  return insertAnalysisInputRevision(db, {
    providerJobId: input.job.id,
    workflowId: input.workflow.id,
    userId: input.workflow.user_id,
    bookId: input.workflow.book_id,
    chapterId: input.sourceSnapshot.canonicalSource.chapter.id,
    jobType: input.job.job_type,
    contentRevisionId: state.contentRevisionId,
    contentRevisionNumber: state.contentRevisionNumber,
    revisionFence: state.revisionFence,
    sourceObjectId: state.sourceObjectId,
    sourceRawTextHash: state.sourceRawTextHash,
    normalizedTextHash: state.normalizedTextHash,
    characterGraphRevisionId: state.graphRevisionId,
    characterGraphFingerprint: state.graphFingerprint,
    correctionFingerprint: corrections.fingerprint,
    requestProfile: requestFields(input.requestProfile),
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptionsFingerprint: providerOptionsIntegrityHash(input.providerOptions),
    providerOptions: input.providerOptions,
    windowSpec: {
      windowId: input.window.id,
      sequence: input.window.sequence,
      chapterAnchors: [
        {
          chapterId: input.sourceSnapshot.canonicalSource.chapter.id,
          chapterIndex: input.sourceSnapshot.canonicalSource.chapter.index,
          textHash: input.sourceSnapshot.canonicalSource.chapter.textHash,
        },
      ],
      paragraphAnchors: paragraphAnchors(input.sourceSnapshot.canonicalSource.paragraphs),
      coversFullChapter: input.sourceSnapshot.coversFullChapter,
      finalWindowForChapter: input.sourceSnapshot.finalWindowForChapter,
    },
    sourceSnapshot: input.sourceSnapshot,
    graphSnapshot: state.graphSnapshot,
    correctionsSnapshot: corrections.corrections,
    episodeContextSnapshot: input.previousEpisodeContext,
    inputHash: input.job.input_hash,
  });
}

export async function pinChapterLabelRepairInput(
  db: RevisionQueryable,
  input: {
    readonly parentRevision: AnalysisInputRevision;
    readonly job: ProviderJobRow;
    readonly candidateArtifact: AnalysisStagingArtifact;
    readonly repairInputFingerprint: string;
    readonly repairIssues: readonly ChapterLabelingValidationIssue[];
    readonly requestProfile: ProviderRequestProfile;
  },
): Promise<AnalysisInputRevision> {
  const parentSource = input.parentRevision.sourceSnapshot;
  if (parentSource.kind !== 'chapter_labeling') {
    throw new Error(`Repair parent input is not a chapter labeling revision: ${input.parentRevision.id}`);
  }
  if (
    input.candidateArtifact.inputRevisionId !== input.parentRevision.id ||
    input.candidateArtifact.providerJobId !== input.parentRevision.providerJobId ||
    input.candidateArtifact.artifactType !== 'chapter_labels'
  ) {
    throw new Error(`Repair candidate does not belong to parent revision: ${input.candidateArtifact.id}`);
  }
  return insertAnalysisInputRevision(db, {
    providerJobId: input.job.id,
    workflowId: input.parentRevision.workflowId,
    userId: input.parentRevision.userId,
    bookId: input.parentRevision.bookId,
    chapterId: input.parentRevision.chapterId,
    jobType: input.job.job_type,
    contentRevisionId: input.parentRevision.contentRevisionId,
    contentRevisionNumber: input.parentRevision.contentRevisionNumber,
    revisionFence: input.parentRevision.revisionFence,
    sourceObjectId: input.parentRevision.sourceObjectId,
    sourceRawTextHash: input.parentRevision.sourceRawTextHash,
    normalizedTextHash: input.parentRevision.normalizedTextHash,
    characterGraphRevisionId: input.parentRevision.characterGraphRevisionId,
    characterGraphFingerprint: input.parentRevision.characterGraphFingerprint,
    correctionFingerprint: input.parentRevision.correctionFingerprint,
    requestProfile: requestFields(input.requestProfile),
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptionsFingerprint: input.parentRevision.providerOptionsFingerprint,
    providerOptions: input.parentRevision.providerOptions,
    windowSpec: input.parentRevision.windowSpec,
    sourceSnapshot: {
      kind: 'chapter_label_repair',
      parentInputRevisionId: input.parentRevision.id,
      parentProviderJobId: input.parentRevision.providerJobId,
      candidateArtifactId: input.candidateArtifact.id,
      candidateOutputHash: input.candidateArtifact.outputHash,
      repairInputFingerprint: input.repairInputFingerprint,
      repairIssues: input.repairIssues,
      chapter: parentSource.chapter,
      paragraphs: parentSource.paragraphs,
      coversFullChapter: parentSource.coversFullChapter,
      finalWindowForChapter: parentSource.finalWindowForChapter,
      contextPacket: parentSource.contextPacket,
    },
    graphSnapshot: input.parentRevision.graphSnapshot,
    correctionsSnapshot: input.parentRevision.correctionsSnapshot,
    episodeContextSnapshot: input.parentRevision.episodeContextSnapshot,
    inputHash: input.job.input_hash,
  });
}

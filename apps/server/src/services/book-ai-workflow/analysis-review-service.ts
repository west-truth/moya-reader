import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type pg from 'pg';
import type {
  ChapterLabelAnalysisReviewArtifact,
  RejectAnalysisReviewInput,
  SaveChapterLabelReviewDraftInput,
} from '../../../../../src/providers/analysis-review';
import type { ChapterLabelingResult } from '../../../../../src/providers/ai';
import { normalizeAnalysisReviewEditIntents } from '../../../../../src/providers/analysis-review-correction';
import { validateChapterLabelingQuality } from '../../../../../src/providers/chapter-labeling-quality';
import { validateChapterLabelingResult } from '../../../../../src/providers/chapter-labeling-validator';
import { loadAnalysisInputRevision } from './analysis-input-repository.js';
import {
  listAnalysisReviewArtifacts,
  loadAnalysisReviewArtifact,
  persistAnalysisReviewDecision,
} from './analysis-review-repository.js';
import { withBookAITransaction } from './transaction.js';
import { analysisReviewRequestProfile, requireAnalysisReviewChapterSource } from './analysis-review-source.js';

export class AnalysisReviewNotFoundError extends Error {
  constructor(reviewId: string) {
    super(`Analysis review artifact not found: ${reviewId}`);
    this.name = 'AnalysisReviewNotFoundError';
  }
}

export class AnalysisReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisReviewConflictError';
  }
}

export class AnalysisReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisReviewInputError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalysisReviewInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AnalysisReviewInputError(`${label} must be a number`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AnalysisReviewInputError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return stringValue(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AnalysisReviewInputError(`${label} must be a string array`);
  }
  return [...value];
}

function reviewCandidate(value: unknown): ChapterLabelingResult {
  const body = record(value, 'candidate');
  if (!Array.isArray(body.characters) || !Array.isArray(body.segments)) {
    throw new AnalysisReviewInputError('candidate characters and segments must be arrays');
  }
  const characters = body.characters.map((value, index) => {
    const character = record(value, `candidate character ${index}`);
    if (typeof character.isUserConfirmed !== 'boolean') {
      throw new AnalysisReviewInputError(`candidate character ${index}.isUserConfirmed must be boolean`);
    }
    return {
      id: stringValue(character.id, `candidate character ${index}.id`),
      novelId: stringValue(character.novelId, `candidate character ${index}.novelId`),
      canonicalName: stringValue(character.canonicalName, `candidate character ${index}.canonicalName`),
      aliases: stringArray(character.aliases, `candidate character ${index}.aliases`),
      color: stringValue(character.color, `candidate character ${index}.color`),
      description: optionalString(character.description, `candidate character ${index}.description`),
      confidence: finiteNumber(character.confidence, `candidate character ${index}.confidence`),
      isUserConfirmed: character.isUserConfirmed,
    };
  });
  const segments = body.segments.map((value, index) => {
    const segment = record(value, `candidate segment ${index}`);
    if (typeof segment.isUserCorrected !== 'boolean') {
      throw new AnalysisReviewInputError(`candidate segment ${index}.isUserCorrected must be boolean`);
    }
    return {
      id: stringValue(segment.id, `candidate segment ${index}.id`),
      novelId: stringValue(segment.novelId, `candidate segment ${index}.novelId`),
      chapterId: stringValue(segment.chapterId, `candidate segment ${index}.chapterId`),
      paragraphId: stringValue(segment.paragraphId, `candidate segment ${index}.paragraphId`),
      segmentIndex: finiteNumber(segment.segmentIndex, `candidate segment ${index}.segmentIndex`),
      startOffset: finiteNumber(segment.startOffset, `candidate segment ${index}.startOffset`),
      endOffset: finiteNumber(segment.endOffset, `candidate segment ${index}.endOffset`),
      segmentTextHash: stringValue(segment.segmentTextHash, `candidate segment ${index}.segmentTextHash`),
      type: stringValue(
        segment.type,
        `candidate segment ${index}.type`,
      ) as ChapterLabelingResult['segments'][number]['type'],
      speakerId: stringValue(segment.speakerId, `candidate segment ${index}.speakerId`),
      candidateSpeakers: stringArray(segment.candidateSpeakers, `candidate segment ${index}.candidateSpeakers`),
      listenerIds: stringArray(segment.listenerIds, `candidate segment ${index}.listenerIds`),
      emotion: stringValue(segment.emotion, `candidate segment ${index}.emotion`),
      confidence: finiteNumber(segment.confidence, `candidate segment ${index}.confidence`),
      evidence: optionalString(segment.evidence, `candidate segment ${index}.evidence`),
      voiceProfileId: optionalString(segment.voiceProfileId, `candidate segment ${index}.voiceProfileId`),
      isUserCorrected: segment.isUserCorrected,
    };
  });
  const contextBody = body.episodeContextSummary
    ? record(body.episodeContextSummary, 'candidate episodeContextSummary')
    : undefined;
  const episodeContextSummary = contextBody
    ? {
        chapterId: stringValue(contextBody.chapterId, 'candidate episodeContextSummary.chapterId'),
        scene: stringValue(contextBody.scene, 'candidate episodeContextSummary.scene'),
        activeCharacterIds: stringArray(
          contextBody.activeCharacterIds,
          'candidate episodeContextSummary.activeCharacterIds',
        ),
        unresolved: stringArray(contextBody.unresolved, 'candidate episodeContextSummary.unresolved'),
        summaryForNextChapter: optionalString(
          contextBody.summaryForNextChapter,
          'candidate episodeContextSummary.summaryForNextChapter',
        ),
        interlocutorEdges: Array.isArray(contextBody.interlocutorEdges)
          ? contextBody.interlocutorEdges.map((value, index) => {
              const edge = record(value, `candidate interlocutor edge ${index}`);
              return {
                sourceCharacterId: stringValue(edge.sourceCharacterId, `candidate interlocutor edge ${index}.source`),
                targetCharacterId: stringValue(edge.targetCharacterId, `candidate interlocutor edge ${index}.target`),
                confidence:
                  edge.confidence === undefined
                    ? undefined
                    : finiteNumber(edge.confidence, `candidate interlocutor edge ${index}.confidence`),
              };
            })
          : undefined,
      }
    : undefined;
  const uncertainties = Array.isArray(body.uncertainties)
    ? body.uncertainties.map((value, index) => {
        const uncertainty = record(value, `candidate uncertainty ${index}`);
        return {
          paragraphId: stringValue(uncertainty.paragraphId, `candidate uncertainty ${index}.paragraphId`),
          startOffset: finiteNumber(uncertainty.startOffset, `candidate uncertainty ${index}.startOffset`),
          endOffset: finiteNumber(uncertainty.endOffset, `candidate uncertainty ${index}.endOffset`),
          reasonCode: stringValue(uncertainty.reasonCode, `candidate uncertainty ${index}.reasonCode`),
          candidateIds: stringArray(uncertainty.candidateIds, `candidate uncertainty ${index}.candidateIds`),
        };
      })
    : undefined;
  const annotationBody = body.segmentAnnotations ? record(body.segmentAnnotations, 'candidate segmentAnnotations') : {};
  const segmentAnnotations = Object.fromEntries(
    Object.entries(annotationBody).map(([segmentId, value]) => {
      const annotation = record(value, `candidate segment annotation ${segmentId}`);
      const prosody = annotation.prosodyIntent
        ? record(annotation.prosodyIntent, `candidate segment annotation ${segmentId}.prosodyIntent`)
        : undefined;
      return [
        segmentId,
        {
          evidenceCodes: stringArray(
            annotation.evidenceCodes,
            `candidate segment annotation ${segmentId}.evidenceCodes`,
          ),
          prosodyIntent: prosody
            ? {
                pace: optionalString(prosody.pace, `candidate segment annotation ${segmentId}.pace`),
                intensity: optionalString(prosody.intensity, `candidate segment annotation ${segmentId}.intensity`),
                delivery: optionalString(prosody.delivery, `candidate segment annotation ${segmentId}.delivery`),
              }
            : undefined,
        },
      ];
    }),
  );
  return {
    characters,
    segments,
    episodeContextSummary,
    uncertainties,
    segmentAnnotations: Object.keys(segmentAnnotations).length > 0 ? segmentAnnotations : undefined,
  };
}

async function requireOpenReview(
  db: pg.PoolClient,
  reviewId: string,
  userId: string,
  expectedRevision: number,
): Promise<ChapterLabelAnalysisReviewArtifact> {
  const review = await loadAnalysisReviewArtifact(db, reviewId, userId, true);
  if (!review) throw new AnalysisReviewNotFoundError(reviewId);
  if (review.reviewRevision !== expectedRevision) {
    throw new AnalysisReviewConflictError(
      `Analysis review revision changed: expected ${expectedRevision}, actual ${review.reviewRevision}`,
    );
  }
  if (!['open', 'editing', 'validating'].includes(review.status)) {
    throw new AnalysisReviewConflictError(`Analysis review is not editable: ${review.status}`);
  }
  return review;
}

export async function listWorkflowAnalysisReviews(
  pool: pg.Pool,
  workflowId: string,
  userId: string,
): Promise<ChapterLabelAnalysisReviewArtifact[]> {
  return listAnalysisReviewArtifacts(pool, workflowId, userId);
}

export async function getAnalysisReview(
  pool: pg.Pool,
  reviewId: string,
  userId: string,
): Promise<ChapterLabelAnalysisReviewArtifact | undefined> {
  return loadAnalysisReviewArtifact(pool, reviewId, userId);
}

export async function saveChapterLabelReviewDraft(
  pool: pg.Pool,
  reviewId: string,
  userId: string,
  input: SaveChapterLabelReviewDraftInput,
): Promise<ChapterLabelAnalysisReviewArtifact> {
  if (!Number.isInteger(input.expectedReviewRevision) || input.expectedReviewRevision <= 0) {
    throw new AnalysisReviewInputError('expectedReviewRevision must be a positive integer');
  }
  const candidate = reviewCandidate(input.candidate);
  let editIntents;
  try {
    editIntents = normalizeAnalysisReviewEditIntents(
      input.editIntents,
      candidate.segments.map((segment) => segment.id),
    );
  } catch (error) {
    throw new AnalysisReviewInputError(
      error instanceof Error
        ? `analysis review edit intent is invalid: ${error.message}`
        : 'analysis review edit intent is invalid',
    );
  }
  return withBookAITransaction(pool, async (client) => {
    const review = await requireOpenReview(client, reviewId, userId, input.expectedReviewRevision);
    const revision = await loadAnalysisInputRevision(client, review.inputRevisionId);
    if (!revision) {
      throw new AnalysisReviewConflictError('Analysis review source revision is unavailable');
    }
    const source = requireAnalysisReviewChapterSource(revision);
    const profile = analysisReviewRequestProfile(revision);
    const validation = validateChapterLabelingResult({
      novelId: revision.bookId,
      chapter: source.chapter,
      paragraphs: [...source.paragraphs],
      knownCharacters: revision.graphSnapshot.characters,
      characterGraph: revision.graphSnapshot,
      previousEpisodeContext: revision.episodeContextSnapshot,
      userCorrections: [...revision.correctionsSnapshot],
      validationPolicy: profile.validationPolicy,
      result: candidate,
    });
    const quality = validateChapterLabelingQuality({
      chapter: source.chapter,
      paragraphs: [...source.paragraphs],
      result: candidate,
    });
    const updated = await persistAnalysisReviewDecision(client, {
      reviewId,
      userId,
      expectedReviewRevision: input.expectedReviewRevision,
      action: 'save_draft',
      status: 'editing',
      candidate,
      candidateHash: structuredIntegrityHash(candidate),
      editIntents,
      validation,
      quality,
      patch: { candidateHash: structuredIntegrityHash(candidate), editIntents },
      provenance: { validation: validation.summary, quality: quality.summary },
    });
    if (!updated) throw new AnalysisReviewConflictError('Analysis review changed before the draft was saved');
    return updated;
  });
}

export async function rejectAnalysisReview(
  pool: pg.Pool,
  reviewId: string,
  userId: string,
  input: RejectAnalysisReviewInput,
): Promise<ChapterLabelAnalysisReviewArtifact> {
  if (!Number.isInteger(input.expectedReviewRevision) || input.expectedReviewRevision <= 0) {
    throw new AnalysisReviewInputError('expectedReviewRevision must be a positive integer');
  }
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 1000)) {
    throw new AnalysisReviewInputError('review rejection reason is invalid');
  }
  return withBookAITransaction(pool, async (client) => {
    await requireOpenReview(client, reviewId, userId, input.expectedReviewRevision);
    const updated = await persistAnalysisReviewDecision(client, {
      reviewId,
      userId,
      expectedReviewRevision: input.expectedReviewRevision,
      action: 'reject',
      status: 'rejected',
      patch: input.reason?.trim() ? { reason: input.reason.trim() } : undefined,
    });
    if (!updated) throw new AnalysisReviewConflictError('Analysis review changed before it was rejected');
    return updated;
  });
}

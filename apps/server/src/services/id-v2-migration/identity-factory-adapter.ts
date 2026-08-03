import { persistentId128 } from '@noveldesk/text-core/hash';
import {
  analysisRunId,
  characterAliasId,
  characterRelationId,
  chapterContextId,
  labeledSegmentId,
  userCorrectionId,
  voiceProfileId,
} from '@noveldesk/text-core/identity/ai';
import { providerJobId, providerSecretId, providerSettingsId } from '@noveldesk/text-core/identity/provider';
import { syncEventId } from '@noveldesk/text-core/identity/sync';
import {
  bookAIBundleId,
  bookAILabelWindowId,
  bookAIWorkflowId,
  bookAIWorkflowJobId,
} from '@noveldesk/text-core/identity/workflow';
import {
  paragraphPageId,
  parsedChapterId,
  parsedNovelId,
  parsedParagraphId,
} from '@noveldesk/text-core/identity/parser';
import { IdV2MigrationError, type IdV2IdentityFactory } from './contracts.js';

function annotationId(
  namespace: 'bookmark' | 'highlight' | 'note',
  input: Parameters<IdV2IdentityFactory['bookmark']>[0],
): string {
  return persistentId128(namespace, [
    input.bookId,
    input.chapterId,
    input.paragraphId ?? '',
    input.createdAt,
    input.sourceId,
  ]);
}

/** Adapts migration rows to the canonical shared domain identity factories. */
export const idV2IdentityFactory = Object.freeze({
  book: parsedNovelId,
  object: (rawTextHash) => persistentId128('object', [rawTextHash]),
  chapter: parsedChapterId,
  paragraph: parsedParagraphId,
  page: paragraphPageId,
  paragraphSearch: (bookId, chapterId, paragraphId) =>
    persistentId128('paragraph_search', [bookId, chapterId, paragraphId]),
  bookmark: (input) => annotationId('bookmark', input),
  highlight: (input) => annotationId('highlight', input),
  note: (input) => annotationId('note', input),
  character: (input) =>
    persistentId128('character', [input.bookId, input.canonicalName.normalize('NFKC').trim(), input.sourceId]),
  characterAlias: characterAliasId,
  characterRelation: (bookId, sourceCharacterId, targetCharacterId, label) =>
    characterRelationId({
      novelId: bookId,
      sourceCharacterId,
      targetCharacterId,
      relationLabel: label,
    }),
  analysisRun: (input) =>
    input.providerJobId && input.outputHash
      ? analysisRunId({
          novelId: input.bookId,
          providerJobId: input.providerJobId,
          inputHash: input.inputHash,
          outputHash: input.outputHash,
        })
      : persistentId128('analysis_run', [
          input.bookId,
          input.providerJobId ?? '',
          input.inputHash,
          input.outputHash ?? '',
          input.runType,
          input.sourceId,
        ]),
  chapterContext: chapterContextId,
  voiceProfile: (input) =>
    voiceProfileId({
      novelId: input.bookId,
      role: input.role,
      characterId: input.characterId,
      providerId: input.providerId,
    }),
  labeledSegment: (input) =>
    labeledSegmentId({
      novelId: input.bookId,
      chapterId: input.chapterId,
      paragraphId: input.paragraphId,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      segmentTextHash: input.segmentTextHash,
    }),
  userCorrection: (input) =>
    input.segmentId
      ? userCorrectionId({
          novelId: input.bookId,
          segmentId: input.segmentId,
          field: input.correctionType,
          createdAt: input.createdAt,
        })
      : persistentId128('correction', [
          input.bookId,
          input.chapterId ?? '',
          input.paragraphId ?? '',
          input.correctionType,
          input.createdAt,
          input.sourceId,
        ]),
  syncEvent: (input) =>
    syncEventId({
      userId: input.userId,
      deviceId: input.deviceId,
      type: input.type,
      novelId: input.bookId,
      entityId: input.entityId,
      seed: `${input.createdAt}:${input.payloadHash}:${input.sourceId}`,
    }),
  bookAIWorkflow: (input) =>
    bookAIWorkflowId({
      userId: input.userId,
      novelId: input.bookId,
      providerId: input.providerId,
      modelId: input.modelId,
      planHash: input.planHash,
      startedAt: input.startedAt,
    }),
  providerJob: (input) =>
    providerJobId({
      userId: input.userId,
      novelId: input.bookId,
      chapterId: input.chapterId,
      jobType: input.jobType,
      providerId: input.providerId,
      modelId: input.modelId,
      inputHash: input.inputHash,
    }),
  workflowJob: bookAIWorkflowJobId,
  workflowPlanItem: (input) => {
    if (input.kind === 'bundle') {
      if (input.startIndex === 'chapter' || input.endIndex === 'chapter') {
        throw new IdV2MigrationError('workflow_plan_invalid', 'A bundle window has invalid indexes.');
      }
      return bookAIBundleId({
        novelId: input.bookId,
        startChapterIndex: input.startIndex,
        endChapterIndex: input.endIndex,
        sourceFingerprint: input.textHashFingerprint,
      });
    }
    if (!input.chapterId) {
      throw new IdV2MigrationError('workflow_plan_invalid', 'A labeling window has no chapter identity.');
    }
    return bookAILabelWindowId({
      novelId: input.bookId,
      chapterId: input.chapterId,
      startParagraphIndex: input.startIndex,
      endParagraphIndex: input.endIndex,
      sourceFingerprint: input.textHashFingerprint,
    });
  },
  providerSettings: providerSettingsId,
  providerSecret: (userId, scope, providerId, secretName) =>
    providerSecretId({ userId, scope, providerId, secretName }),
} satisfies IdV2IdentityFactory);

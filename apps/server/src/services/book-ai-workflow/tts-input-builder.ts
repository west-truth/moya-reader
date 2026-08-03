import { matchesIntegrityHash } from '@noveldesk/text-core/hash';
import { providerOptionsIntegrityHash } from '@noveldesk/text-core/identity/provider';
import { segmentTextIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { VoiceProfile } from '@noveldesk/contracts';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import type {
  ProviderCapabilitySnapshot,
  ProviderTaskProfileSnapshot,
} from '../../../../../src/providers/provider-capability';
import { loadChapter, loadTTSSegmentTextRows } from '../provider-jobs/job-data-loader.js';
import type { AnalysisInputRevision } from './analysis-input-contracts.js';
import { insertAnalysisInputRevision, type RevisionQueryable } from './analysis-input-repository.js';
import { loadPinnedCorrections, lockBookRevisionState } from './revision-snapshot-repository.js';

export interface PinTTSInputRevisionInput {
  readonly job: ProviderJobRow;
  readonly workflowId?: string;
  readonly renderSpec: TTSRenderSpec;
  readonly renderSpecHash: string;
  readonly voiceProfile: VoiceProfile;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly capabilitySnapshot?: ProviderCapabilitySnapshot;
  readonly taskProfileSnapshot?: ProviderTaskProfileSnapshot;
}

export async function pinTTSInputRevision(
  db: RevisionQueryable,
  input: PinTTSInputRevisionInput,
): Promise<AnalysisInputRevision> {
  const state = await lockBookRevisionState(db, input.job.user_id, input.job.book_id);
  if (!state) throw new Error(`Book not found for TTS input revision: ${input.job.book_id}`);
  const chapter = await loadChapter(db, input.job);
  const rows = await loadTTSSegmentTextRows(
    db,
    input.job,
    input.renderSpec.segmentAnchors.map((item) => item.segmentId),
    input.renderSpec,
  );
  const text = rows.map((row) => row.text.slice(Number(row.start_offset), Number(row.end_offset))).join('\n');
  if (!matchesIntegrityHash(input.renderSpec.inputTextHash, text)) {
    throw new Error('TTS render spec text does not match the pinned source');
  }
  const paragraphRows = await db.query<{
    paragraph_id: string;
    chapter_id: string;
    paragraph_index: number | string;
    text: string;
  }>(
    `
      select paragraph_id, chapter_id, paragraph_index, text
      from paragraph_search
      where book_id = $1 and paragraph_id = any($2::text[])
      order by paragraph_index
    `,
    [input.job.book_id, [...new Set(rows.map((row) => row.paragraph_id))]],
  );
  const corrections = await loadPinnedCorrections(db, state, chapter.id);
  return insertAnalysisInputRevision(db, {
    providerJobId: input.job.id,
    workflowId: input.workflowId,
    userId: input.job.user_id,
    bookId: input.job.book_id,
    chapterId: chapter.id,
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
    requestProfile: {
      id: 'tts-render-spec-v1',
      promptVersion: 'tts-render-v1',
      schemaVersion: 'tts-render-spec-v1',
    },
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptionsFingerprint: providerOptionsIntegrityHash(input.providerOptions),
    providerOptions: input.providerOptions,
    capabilitySnapshot: input.capabilitySnapshot,
    taskProfileSnapshot: input.taskProfileSnapshot,
    windowSpec: {
      windowId: input.renderSpecHash,
      sequence: 0,
      chapterAnchors: [{ chapterId: chapter.id, chapterIndex: chapter.index, textHash: chapter.textHash }],
      paragraphAnchors: paragraphRows.rows.map((row) => ({
        paragraphId: row.paragraph_id,
        chapterId: row.chapter_id,
        paragraphIndex: Number(row.paragraph_index),
        textHash: textIntegrityHash(row.text),
      })),
      coversFullChapter: false,
      finalWindowForChapter: false,
    },
    sourceSnapshot: {
      kind: 'tts_synthesis',
      chapterId: chapter.id,
      segmentIds: rows.map((row) => row.id),
      text,
      segmentTextHashes: Object.fromEntries(
        rows.map((row) => [
          row.id,
          segmentTextIntegrityHash(row.text.slice(Number(row.start_offset), Number(row.end_offset))),
        ]),
      ),
    },
    graphSnapshot: state.graphSnapshot,
    correctionsSnapshot: corrections.corrections,
    renderSpec: input.renderSpec,
    renderSpecHash: input.renderSpecHash,
    voiceProfileSnapshot: input.voiceProfile,
    inputHash: input.job.input_hash,
  });
}

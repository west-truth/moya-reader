import { providerOptionsIntegrityHash } from '@noveldesk/text-core/identity/provider';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import { matchesTTSRenderSpecHash, type TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { ProviderJobRow, ProviderRequestProfile } from '../provider-jobs/contracts.js';
import { AnalysisInputStaleError, type AnalysisInputRevision } from './analysis-input-contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';
import { loadPinnedCorrections, lockBookRevisionState } from './revision-snapshot-repository.js';

interface ChapterVerificationRow {
  id: string;
  chapter_index: number | string;
  text_hash: string;
}

interface ParagraphVerificationRow {
  paragraph_id: string;
  chapter_id: string;
  paragraph_index: number | string;
  text: string;
}

export function assertPinnedRequestProfile(revision: AnalysisInputRevision, profile: ProviderRequestProfile): void {
  if (
    revision.requestProfile.id !== profile.id ||
    revision.requestProfile.promptVersion !== profile.promptVersion ||
    revision.requestProfile.schemaVersion !== profile.schemaVersion
  ) {
    throw new AnalysisInputStaleError(
      'analysis_profile_stale',
      `Pinned request profile no longer resolves identically for provider job ${revision.providerJobId}`,
    );
  }
  if (providerOptionsIntegrityHash(revision.providerOptions) !== revision.providerOptionsFingerprint) {
    throw new AnalysisInputStaleError(
      'analysis_profile_stale',
      `Pinned provider options fingerprint is invalid for provider job ${revision.providerJobId}`,
    );
  }
}

export function assertPinnedRepairRequestProfile(
  revision: AnalysisInputRevision,
  profile: ProviderRequestProfile,
): void {
  const pinned =
    revision.sourceSnapshot.kind === 'chapter_labeling' ? revision.sourceSnapshot.repairRequestProfile : undefined;
  if (
    !pinned ||
    pinned.id !== profile.id ||
    pinned.promptVersion !== profile.promptVersion ||
    pinned.schemaVersion !== profile.schemaVersion
  ) {
    throw new AnalysisInputStaleError(
      'analysis_profile_stale',
      `Pinned repair request profile no longer resolves identically for provider job ${revision.providerJobId}`,
    );
  }
}

export function assertPinnedRenderSpec(revision: AnalysisInputRevision, renderSpec: TTSRenderSpec): void {
  if (!revision.renderSpec || !revision.renderSpecHash) {
    throw new AnalysisInputStaleError('analysis_render_spec_stale', 'TTS input revision has no pinned render spec');
  }
  if (!matchesTTSRenderSpecHash(revision.renderSpecHash, revision.renderSpec)) {
    throw new AnalysisInputStaleError('analysis_render_spec_stale', 'Pinned TTS render spec hash is invalid');
  }
  if (JSON.stringify(revision.renderSpec) !== JSON.stringify(renderSpec)) {
    throw new AnalysisInputStaleError('analysis_render_spec_stale', 'TTS render spec differs from its pinned input');
  }
}

export async function verifyAnalysisInputBeforeExecution(
  db: RevisionQueryable,
  job: ProviderJobRow,
  revision: AnalysisInputRevision,
  options: { readonly lock?: boolean } = {},
): Promise<void> {
  if (
    revision.providerJobId !== job.id ||
    revision.userId !== job.user_id ||
    revision.bookId !== job.book_id ||
    revision.chapterId !== (job.chapter_id ?? undefined) ||
    revision.jobType !== job.job_type ||
    revision.providerId !== job.provider_id ||
    revision.modelId !== (job.model_id ?? undefined) ||
    revision.inputHash !== job.input_hash
  ) {
    throw new AnalysisInputStaleError(
      'analysis_source_stale',
      `Provider job input identity is inconsistent: ${job.id}`,
    );
  }

  const state = await lockBookRevisionState(db, job.user_id, job.book_id, { lock: options.lock === true });
  if (!state || state.contentRevisionId !== revision.contentRevisionId) {
    throw new AnalysisInputStaleError(
      'analysis_content_revision_stale',
      `Book content revision changed before provider job execution: ${job.id}`,
    );
  }
  if (state.revisionFence !== revision.revisionFence) {
    throw new AnalysisInputStaleError(
      'analysis_revision_fence_stale',
      `Book replacement fence changed before provider job execution: ${job.id}`,
    );
  }
  if (revision.characterGraphRevisionId !== undefined && state.graphRevisionId !== revision.characterGraphRevisionId) {
    throw new AnalysisInputStaleError(
      'analysis_graph_revision_stale',
      `Character graph revision changed before provider job execution: ${job.id}`,
    );
  }
  if (state.normalizedTextHash !== revision.normalizedTextHash) {
    throw new AnalysisInputStaleError('analysis_source_stale', `Book source hash changed before execution: ${job.id}`);
  }
  if (state.sourceObjectId !== revision.sourceObjectId || state.sourceRawTextHash !== revision.sourceRawTextHash) {
    throw new AnalysisInputStaleError(
      'analysis_source_stale',
      `Book source object changed before provider job execution: ${job.id}`,
    );
  }

  await verifyChapterAnchors(db, revision);
  await verifyParagraphAnchors(db, revision);
  const currentCorrections = await loadPinnedCorrections(db, state, revision.chapterId);
  if (currentCorrections.fingerprint !== revision.correctionFingerprint) {
    throw new AnalysisInputStaleError(
      'analysis_corrections_stale',
      `User corrections changed before provider job execution: ${job.id}`,
    );
  }
}

async function verifyChapterAnchors(db: RevisionQueryable, revision: AnalysisInputRevision): Promise<void> {
  const anchors = revision.windowSpec.chapterAnchors;
  if (anchors.length === 0) return;
  const result = await db.query<ChapterVerificationRow>(
    `
      select id, chapter_index, text_hash
      from chapters
      where book_id = $1 and id = any($2::text[])
    `,
    [revision.bookId, anchors.map((anchor) => anchor.chapterId)],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  for (const anchor of anchors) {
    const row = byId.get(anchor.chapterId);
    if (!row || Number(row.chapter_index) !== anchor.chapterIndex || row.text_hash !== anchor.textHash) {
      throw new AnalysisInputStaleError(
        'analysis_source_stale',
        `Pinned chapter source changed before provider job execution: ${anchor.chapterId}`,
      );
    }
  }
}

async function verifyParagraphAnchors(db: RevisionQueryable, revision: AnalysisInputRevision): Promise<void> {
  const anchors = [...revision.windowSpec.paragraphAnchors, ...(revision.windowSpec.contextParagraphAnchors ?? [])];
  if (anchors.length === 0) return;
  const result = await db.query<ParagraphVerificationRow>(
    `
      select paragraph_id, chapter_id, paragraph_index, text
      from paragraph_search
      where book_id = $1 and paragraph_id = any($2::text[])
    `,
    [revision.bookId, anchors.map((anchor) => anchor.paragraphId)],
  );
  const byId = new Map(result.rows.map((row) => [row.paragraph_id, row]));
  for (const anchor of anchors) {
    const row = byId.get(anchor.paragraphId);
    if (
      !row ||
      row.chapter_id !== anchor.chapterId ||
      Number(row.paragraph_index) !== anchor.paragraphIndex ||
      textIntegrityHash(row.text) !== anchor.textHash
    ) {
      throw new AnalysisInputStaleError(
        'analysis_source_stale',
        `Pinned paragraph source changed before provider job execution: ${anchor.paragraphId}`,
      );
    }
  }
}

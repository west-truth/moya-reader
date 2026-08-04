import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { providerOptionsIntegrityHash } from '@noveldesk/text-core/identity/provider';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import { resolveCharacterGraphMergeRequestProfile } from '../../../../../src/providers/character-graph-request-profile';
import type { AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import { processCharacterBundleAnalysisJob, processCharacterGraphMergeJob } from './character-graph-handlers.js';
import type { ProviderJobRow, ProviderRequestProfile } from './contracts.js';
import { testConfig } from './provider-job-test-harness.js';

const pool = {} as pg.Pool;

function job(jobType: ProviderJobRow['job_type']): ProviderJobRow {
  return {
    id: `job_${jobType}`,
    user_id: 'user_test',
    book_id: 'book_1',
    chapter_id: null,
    job_type: jobType,
    provider_id: 'mock',
    model_id: 'mock-model',
    input_hash: `input_${jobType}`,
    status: 'running',
    progress: {},
  };
}

function revision(providerJob: ProviderJobRow, profile: ProviderRequestProfile): AnalysisInputRevision {
  const providerOptions = {};
  return {
    id: `revision_${providerJob.id}`,
    providerJobId: providerJob.id,
    workflowId: 'workflow_1',
    userId: providerJob.user_id,
    bookId: providerJob.book_id,
    jobType: providerJob.job_type,
    contentRevisionId: 'content_revision_1',
    contentRevisionNumber: 1,
    revisionFence: 1,
    normalizedTextHash: 'normalized_hash_1',
    characterGraphFingerprint: 'graph_hash_1',
    correctionFingerprint: 'correction_hash_1',
    requestProfile: {
      id: profile.id,
      promptVersion: profile.promptVersion,
      schemaVersion: profile.schemaVersion,
    },
    providerId: providerJob.provider_id,
    modelId: providerJob.model_id ?? undefined,
    providerOptionsFingerprint: providerOptionsIntegrityHash(providerOptions),
    providerOptions,
    windowSpec: {
      windowId: 'window_1',
      sequence: 0,
      chapterAnchors: [],
      paragraphAnchors: [],
    },
    sourceSnapshot: {
      kind: 'tts_synthesis',
      chapterId: 'chapter_1',
      segmentIds: ['segment_1'],
      text: 'Pinned text',
      segmentTextHashes: { segment_1: 'segment_hash_1' },
    },
    graphSnapshot: { novelId: providerJob.book_id, characters: [], relations: [] },
    correctionsSnapshot: [],
    inputHash: providerJob.input_hash,
    createdAt: '2026-07-10T00:00:00.000Z',
  };
}

describe('character graph pinned input dispatch', () => {
  it('rejects a bundle job whose pinned source has the wrong kind', async () => {
    const providerJob = job('character_bundle_analysis');
    const inputRevision = revision(providerJob, resolveCharacterBundleAnalysisRequestProfile({}));

    await expect(
      processCharacterBundleAnalysisJob(pool, testConfig(), providerJob, {}, undefined, inputRevision),
    ).rejects.toMatchObject({ code: 'analysis_source_stale' });
  });

  it('rejects a graph merge job whose pinned source has the wrong kind', async () => {
    const providerJob = job('character_graph_merge');
    const inputRevision = revision(providerJob, resolveCharacterGraphMergeRequestProfile({}));

    await expect(
      processCharacterGraphMergeJob(pool, testConfig(), providerJob, {}, undefined, inputRevision),
    ).rejects.toMatchObject({ code: 'analysis_source_stale' });
  });
});

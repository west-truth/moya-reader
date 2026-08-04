import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ttsInputTextIntegrityHash } from '@noveldesk/text-core/identity/tts';
import type { VoiceProfile } from '@noveldesk/contracts';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';

const mocks = vi.hoisted(() => ({
  loadChapter: vi.fn(),
  loadTTSSegmentTextRows: vi.fn(),
  insertAnalysisInputRevision: vi.fn(),
  loadPinnedCorrections: vi.fn(),
  lockBookRevisionState: vi.fn(),
}));

vi.mock('../provider-jobs/job-data-loader.js', () => ({
  loadChapter: mocks.loadChapter,
  loadTTSSegmentTextRows: mocks.loadTTSSegmentTextRows,
}));
vi.mock('./analysis-input-repository.js', () => ({
  insertAnalysisInputRevision: mocks.insertAnalysisInputRevision,
}));
vi.mock('./revision-snapshot-repository.js', () => ({
  loadPinnedCorrections: mocks.loadPinnedCorrections,
  lockBookRevisionState: mocks.lockBookRevisionState,
}));

import { pinTTSInputRevision } from './tts-input-builder.js';

describe('fixed-document TTS input pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockBookRevisionState.mockResolvedValue({
      contentRevisionId: 'revision_1',
      contentRevisionNumber: 1,
      revisionFence: 'fence_1',
      sourceObjectId: 'source_1',
      sourceRawTextHash: 'source_hash_1',
      normalizedTextHash: 'normalized_hash_1',
      graphRevisionId: undefined,
      graphFingerprint: undefined,
      graphSnapshot: undefined,
    });
    mocks.loadChapter.mockResolvedValue({
      id: 'chapter_1',
      novelId: 'book_1',
      index: 1,
      title: '1페이지',
      normalizedText: '1페이지',
      textHash: 'chapter_hash_1',
      rawStartOffset: 0,
      rawEndOffset: 1,
      characterCount: 4,
      paragraphCount: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    mocks.loadTTSSegmentTextRows.mockResolvedValue([
      {
        id: 'block_1',
        paragraph_id: 'block_1',
        segment_index: 0,
        start_offset: 7,
        end_offset: 13,
        segment_text_hash: 'segment_hash_1',
        speaker_id: 'narrator',
        emotion: 'neutral',
        text: 'before target after',
      },
    ]);
    mocks.loadPinnedCorrections.mockResolvedValue({ fingerprint: 'corrections_1', corrections: [] });
    mocks.insertAnalysisInputRevision.mockImplementation(async (_db, input) => input);
  });

  it('pins the exact uploaded block range through the same render spec used by the worker', async () => {
    const renderSpec = {
      novelId: 'book_1',
      chapterId: 'chapter_1',
      speakerId: 'narrator',
      voiceProfileId: 'voice_1',
      providerId: 'mock-tts',
      providerVoiceId: 'voice',
      voiceProfileRevision: '2026-08-01T00:00:00.000Z',
      segmentAnchors: [
        {
          segmentId: 'block_1',
          paragraphId: 'block_1',
          startOffset: 7,
          endOffset: 13,
        },
      ],
      inputTextHash: ttsInputTextIntegrityHash('target'),
      providerOptionsHash: 'options_hash_1',
      format: 'mp3',
    } as TTSRenderSpec;
    const job = {
      id: 'job_1',
      user_id: 'user_1',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'mock-tts',
      model_id: null,
      input_hash: 'input_hash_1',
      status: 'queued',
      progress: {},
    } as ProviderJobRow;
    const voiceProfile = {
      id: 'voice_1',
      novelId: 'book_1',
      role: 'narrator',
      providerId: 'mock-tts',
      providerVoiceId: 'voice',
      label: 'Narrator',
      speed: 1,
      isUserSelected: true,
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as VoiceProfile;
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as RevisionQueryable;

    const revision = await pinTTSInputRevision(db, {
      job,
      renderSpec,
      renderSpecHash: 'render_hash_1',
      voiceProfile,
      providerOptions: {},
    });

    expect(mocks.loadTTSSegmentTextRows).toHaveBeenCalledWith(db, job, ['block_1'], renderSpec);
    expect(revision.sourceSnapshot).toMatchObject({ kind: 'tts_synthesis', segmentIds: ['block_1'], text: 'target' });
  });
});

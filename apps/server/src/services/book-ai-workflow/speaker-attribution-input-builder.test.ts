import { describe, expect, it, vi } from 'vitest';
import type { AnalysisInputRevision, SpeakerAttributionSourceSnapshot } from './analysis-input-contracts.js';
import type { BookAIWorkflowRow } from './workflow-contracts.js';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';

const repositories = vi.hoisted(() => ({
  insertRevision: vi.fn(),
  lockRevisionState: vi.fn(),
  loadCorrections: vi.fn(),
}));

vi.mock('./analysis-input-repository.js', () => ({
  insertAnalysisInputRevision: repositories.insertRevision,
}));

vi.mock('./revision-snapshot-repository.js', () => ({
  lockBookRevisionState: repositories.lockRevisionState,
  loadPinnedCorrections: repositories.loadCorrections,
  pinParagraphText: vi.fn((value) => value),
}));

import { pinSpeakerAttributionInput } from './analysis-input-builder.js';

describe('compact speaker input revision pinning', () => {
  it('pins the previous episode context and recent turns with the immutable compact source', async () => {
    const graphSnapshot = { novelId: 'book_1', characters: [], relations: [] };
    repositories.lockRevisionState.mockResolvedValue({
      contentRevisionId: 'content_revision_1',
      contentRevisionNumber: 3,
      revisionFence: 8,
      sourceObjectId: 'source_1',
      sourceRawTextHash: 'raw_hash_1',
      normalizedTextHash: 'normalized_hash_1',
      graphRevisionId: 'graph_revision_1',
      graphFingerprint: 'graph_hash_1',
      graphSnapshot,
    });
    repositories.loadCorrections.mockResolvedValue({ fingerprint: 'correction_hash_1', corrections: [] });
    repositories.insertRevision.mockImplementation(
      async (_db, input) =>
        ({
          ...input,
          id: 'input_revision_1',
          createdAt: '2026-07-13T00:00:00.000Z',
        }) as AnalysisInputRevision,
    );

    const workflow = {
      id: 'workflow_1',
      user_id: 'user_1',
      book_id: 'book_1',
      content_revision_id: 'content_revision_1',
      revision_fence: 8,
    } as BookAIWorkflowRow;
    const job: ProviderJobRow = {
      id: 'job_1',
      user_id: 'user_1',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'speaker_attribution_v3',
      provider_id: 'mock',
      model_id: 'mock-speaker-v1',
      input_hash: 'input_hash_1',
      status: 'queued',
      progress: {},
    };
    const sourceSnapshot = {
      kind: 'speaker_attribution_v3',
      coversFullChapter: false,
      finalWindowForChapter: false,
      canonicalSource: {
        chapter: { id: 'chapter_1', index: 1, textHash: 'chapter_hash_1' },
        paragraphs: [{ id: 'paragraph_1', chapterId: 'chapter_1', index: 0, textHash: 'paragraph_hash_1' }],
      },
    } as unknown as SpeakerAttributionSourceSnapshot;
    const previousEpisodeContext = {
      chapterId: 'chapter_0',
      summary: 'Previous accepted context.',
      activeCharacterIds: ['character_1'],
      unresolved: [],
      recentTurns: [
        {
          paragraphId: 'paragraph_0',
          speakerId: 'character_1',
          listenerIds: [],
          emotion: 'neutral',
          text: 'Pinned recent turn.',
        },
      ],
    };

    await pinSpeakerAttributionInput({} as never, {
      workflow,
      job,
      window: {
        id: 'window_1',
        sequence: 0,
        chapterId: 'chapter_1',
        chapterIndex: 1,
        paragraphIds: ['paragraph_1'],
        startParagraphIndex: 0,
        endParagraphIndex: 0,
        characterCount: 12,
        textHashFingerprint: 'window_hash_1',
        dependsOnGraph: true,
      },
      providerOptions: {},
      requestProfile: {
        id: 'speaker-attribution-v3-compact',
        promptVersion: 'speaker-attributor-v4-readable-v1',
        schemaVersion: 'speaker-wire-v2',
      },
      sourceSnapshot,
      previousEpisodeContext,
    });

    expect(repositories.insertRevision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceSnapshot,
        episodeContextSnapshot: previousEpisodeContext,
        windowSpec: expect.objectContaining({
          windowId: 'window_1',
          paragraphAnchors: [expect.objectContaining({ paragraphId: 'paragraph_1' })],
        }),
      }),
    );
  });
});

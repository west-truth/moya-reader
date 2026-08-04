import { describe, expect, it, vi } from 'vitest';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { ProviderJobRow } from './contracts.js';
import { loadTTSSegmentTextRows, type ProviderJobQueryable } from './job-data-loader.js';

describe('fixed-document TTS source loading', () => {
  it('materializes only the exact uploaded block range when labeled segments are absent', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('from labeled_segments')) return { rows: [], rowCount: 0 };
      if (sql.includes('from document_text_blocks')) {
        return { rows: [{ id: 'block_1', block_order: 2, text: 'first sentence. second sentence.' }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const job: ProviderJobRow = {
      id: 'job_1',
      user_id: 'user_1',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'provider_1',
      model_id: null,
      input_hash: 'input_1',
      status: 'running',
      progress: {},
    };
    const renderSpec = {
      speakerId: 'narrator',
      emotion: 'neutral',
      segmentAnchors: [
        {
          segmentId: 'block_1',
          paragraphId: 'block_1',
          startOffset: 16,
          endOffset: 32,
        },
      ],
    } as TTSRenderSpec;

    await expect(
      loadTTSSegmentTextRows({ query } as unknown as ProviderJobQueryable, job, ['block_1'], renderSpec),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'block_1',
        paragraph_id: 'block_1',
        start_offset: 16,
        end_offset: 32,
        speaker_id: 'narrator',
        text: 'first sentence. second sentence.',
      }),
    ]);
    expect(query.mock.calls[1]?.[0]).toContain('c.chapter_index = b.page_index + 1');
    expect(query.mock.calls[1]?.[1]).toEqual(['book_1', 'chapter_1', ['block_1']]);
  });
});

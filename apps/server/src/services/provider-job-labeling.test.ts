import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { processProviderJob } from './provider-job-service.js';
import { hashSync } from '@noveldesk/text-core/legacy-hash';
import { integrityHash } from '@noveldesk/text-core/hash';
import { STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID } from '../../../../src/providers/chapter-labeling-request-profile';
import type { AIProvider } from '../../../../src/providers/ai';
import type { LabeledSegment, Paragraph } from '@noveldesk/contracts';
import { capturedSyncEvent, testConfig } from './provider-jobs/provider-job-test-harness.js';

describe('provider job chapter labeling', () => {
  it('runs mock chapter labeling and stores characters and generated segments', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_1',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: { providerOptions: { requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID } },
    };
    const characters: Record<string, unknown>[] = [];
    const segments: Record<string, unknown>[] = [];
    const analysisRuns: Record<string, unknown>[] = [];
    const syncEvents: Record<string, unknown>[] = [];
    const books = new Map([['book_1', { analysis_status: 'queued' }]]);

    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_chapter', 'labeling_segments', 'writing_results', 'ready', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from chapters c')) {
        return {
          rows: [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter 1',
              text_hash: 'chapter_hash',
              raw_start_offset: 0,
              raw_end_offset: 42,
              character_count: 42,
              paragraph_count: 2,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from paragraph_search') && sql.includes('paragraph_index between')) {
        expect(params).toEqual(['chapter_1', 0, 3, 0, 1]);
        return { rows: [] };
      }
      if (sql.includes('from paragraph_search')) {
        return {
          rows: [
            {
              paragraph_id: 'paragraph_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_index: 0,
              text: '"Hello."',
              paragraph: {
                id: 'paragraph_1',
                novelId: 'book_1',
                chapterId: 'chapter_1',
                index: 0,
                text: '"Hello."',
                startOffsetInChapter: 0,
                endOffsetInChapter: 8,
                textHash: hashSync('"Hello."'),
              },
            },
            {
              paragraph_id: 'paragraph_2',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_index: 1,
              text: '[System]',
              paragraph: {
                id: 'paragraph_2',
                novelId: 'book_1',
                chapterId: 'chapter_1',
                index: 1,
                text: '[System]',
                startOffsetInChapter: 9,
                endOffsetInChapter: 17,
                textHash: hashSync('[System]'),
              },
            },
          ],
        };
      }
      if (sql.includes('from characters')) {
        return {
          rows: [
            {
              id: 'char_1',
              book_id: 'book_1',
              canonical_name: 'Alex',
              aliases: ['Al'],
              color: '#3b82f6',
              description: 'Known protagonist.',
              confidence: 0.93,
              is_user_confirmed: true,
            },
          ],
        };
      }
      if (sql.includes('from character_relations')) {
        return { rows: [] };
      }
      if (sql.includes('from chapter_contexts')) {
        return {
          rows: [
            {
              chapter_id: 'chapter_0',
              summary: 'Alex was active in the previous scene.',
              active_character_ids: ['char_1'],
              unresolved: ['previous uncertain speaker'],
            },
          ],
        };
      }
      if (sql.includes('from user_corrections')) {
        return {
          rows: [
            {
              id: 'correction_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_id: 'paragraph_1',
              segment_id: 'segment_1',
              correction_type: 'speaker',
              before_json: { speakerId: 'unknown' },
              after_json: { speakerId: 'char_1' },
              apply_scope: 'future_pattern',
              created_at: '2026-07-06T00:01:00.000Z',
            },
          ],
        };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('insert into analysis_runs')) {
        analysisRuns.push({
          id: params?.[0],
          book_id: params?.[1],
          chapter_id: params?.[2],
          prompt_version: params?.[6],
          output_hash: params?.[8],
          metadata: JSON.parse(String(params?.[9])),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into characters')) {
        characters.push({ id: params?.[0], book_id: params?.[1], canonical_name: params?.[3] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('delete from labeled_segments')) {
        segments.length = 0;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into labeled_segments')) {
        segments.push({
          id: params?.[0],
          book_id: params?.[1],
          chapter_id: params?.[2],
          paragraph_id: params?.[3],
          segment_index: params?.[4],
          speaker_id: params?.[9],
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) {
        books.set(String(params?.[1]), { analysis_status: String(params?.[0]) });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into sync_events')) {
        syncEvents.push(capturedSyncEvent(params));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('select payload from character_')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = {
      query: handleQuery,
      release: vi.fn(),
    };
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_1');

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.stage).toBe('ready');
    expect(jobRow.progress).toMatchObject({
      providerOptions: { requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID },
      characterCount: 3,
      segmentCount: 2,
      validation: { errorCount: 0 },
      quality: { errorCount: 0 },
      relationCount: 0,
    });
    expect(analysisRuns).toHaveLength(1);
    expect(analysisRuns[0]).toMatchObject({
      prompt_version: 'chapter-labeler-v1-strict-tts-windowed',
      metadata: {
        requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        schemaVersion: 'chapter-labeling-result-v1',
        validation: { errorCount: 0 },
        quality: { errorCount: 0 },
      },
    });
    expect(characters.length).toBeGreaterThan(0);
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.paragraph_id)).toEqual(['paragraph_1', 'paragraph_2']);
    expect(syncEvents.map((event) => event.type)).toEqual(['character_graph_updated', 'chapter_segments_updated']);
    expect(syncEvents[0]).toMatchObject({
      book_id: 'book_1',
      entity_id: 'character_graph_book_1',
      payload: { mode: 'patch' },
      revision: { entityType: 'character_graph', entityId: 'character_graph_book_1', novelId: 'book_1' },
    });
    expect(syncEvents[1]).toMatchObject({
      book_id: 'book_1',
      entity_id: 'chapter_segments_chapter_1',
      payload: { chapterId: 'chapter_1' },
      revision: { entityType: 'chapter_segments', entityId: 'chapter_segments_chapter_1', novelId: 'book_1' },
    });
    expect(books.get('book_1')).toEqual({ analysis_status: 'mock_ready' });
    expect(client.release).toHaveBeenCalled();
  });

  it('runs windowed chapter labeling against scoped paragraphs and emits segment patch payloads', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_windowed',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash_windowed',
      status: 'queued',
      stage: 'queued',
      progress: {
        providerOptions: { requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID },
        sourceContext: {
          paragraphIds: ['paragraph_1'],
          coversFullChapter: false,
        },
      },
    };
    const deleteCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const syncEvents: Record<string, unknown>[] = [];
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback')
        return { rowCount: 0, rows: [] };
      if (sql.trim().startsWith('update provider_jobs')) {
        if (sql.includes("and status = 'queued'")) {
          jobRow.status = 'running';
          jobRow.stage = 'loading_chapter';
          jobRow.progress = { ...(jobRow.progress as Record<string, unknown>), loaded: false };
          return { rowCount: 1, rows: [jobRow] };
        }
        const values = params ?? [];
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        const stage = values.find((value) =>
          ['loading_chapter', 'labeling_segments', 'writing_results', 'ready'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from chapters c')) {
        return {
          rows: [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter 1',
              text_hash: 'chapter_hash',
              raw_start_offset: 0,
              raw_end_offset: 42,
              character_count: 42,
              paragraph_count: 2,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from paragraph_search') && sql.includes('paragraph_index between')) {
        expect(params).toEqual(['chapter_1', 0, 2, 0, 0]);
        return { rows: [] };
      }
      if (sql.includes('from paragraph_search')) {
        expect(params).toEqual(['chapter_1', ['paragraph_1']]);
        return {
          rows: [
            {
              paragraph_id: 'paragraph_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_index: 0,
              text: '"Hello."',
              paragraph: {
                id: 'paragraph_1',
                novelId: 'book_1',
                chapterId: 'chapter_1',
                index: 0,
                text: '"Hello."',
                startOffsetInChapter: 0,
                endOffsetInChapter: 8,
                textHash: hashSync('"Hello."'),
              },
            },
          ],
        };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from chapter_contexts') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (sql.includes('insert into analysis_runs')) return { rowCount: 1, rows: [] };
      if (sql.includes('insert into characters')) return { rowCount: 1, rows: [] };
      if (sql.includes('delete from labeled_segments')) {
        deleteCalls.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into labeled_segments')) return { rowCount: 1, rows: [] };
      if (sql.includes('update library_books set analysis_status')) return { rowCount: 1, rows: [] };
      if (sql.includes('insert into sync_events')) {
        syncEvents.push(capturedSyncEvent(params));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('select payload from character_')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query: handleQuery, release: vi.fn() };
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_windowed');

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.progress).toMatchObject({
      paragraphIds: ['paragraph_1'],
      coversFullChapter: false,
      segmentCount: 1,
    });
    expect(deleteCalls).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining('paragraph_id = any($3::text[])'),
        params: ['book_1', 'chapter_1', ['paragraph_1']],
      }),
    ]);
    expect(syncEvents.find((event) => event.type === 'chapter_segments_updated')).toMatchObject({
      payload: {
        mode: 'patch',
        chapterId: 'chapter_1',
        paragraphIds: ['paragraph_1'],
      },
    });
    expect(handleQuery.mock.calls.some(([sql]) => String(sql).includes('insert into chapter_contexts'))).toBe(false);
  });

  it('fails chapter labeling jobs before storage when validation rejects generated anchors', async () => {
    const provider: AIProvider = {
      providerId: 'mock_invalid',
      displayName: 'Invalid Mock',
      labelChapterSegments: vi.fn(async () => ({
        characters: [],
        segments: [
          {
            id: 'segment_invalid',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            paragraphId: 'paragraph_1',
            segmentIndex: 0,
            startOffset: 0,
            endOffset: 8,
            segmentTextHash: 'stale_hash',
            type: 'quoted_dialogue' as const,
            speakerId: 'unknown',
            candidateSpeakers: [],
            listenerIds: [],
            emotion: 'neutral',
            confidence: 0.7,
            isUserCorrected: false,
          },
        ],
      })),
    };
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_invalid_labels',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {},
    };
    const segments: Record<string, unknown>[] = [];
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
      if (sql.trim().startsWith('update provider_jobs')) {
        if (sql.includes("and status = 'queued'")) {
          jobRow.status = 'running';
          jobRow.stage = 'loading_chapter';
          jobRow.progress = { ...(jobRow.progress as Record<string, unknown>), loaded: false };
          return { rowCount: 1, rows: [jobRow] };
        }
        const values = params ?? [];
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_chapter', 'labeling_segments', 'writing_results', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        jobRow.error_message = params?.find(
          (value) => typeof value === 'string' && String(value).includes('Chapter labeling validation failed'),
        );
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from chapters c')) {
        return {
          rows: [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter 1',
              text_hash: 'chapter_hash',
              raw_start_offset: 0,
              raw_end_offset: 8,
              character_count: 8,
              paragraph_count: 1,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from paragraph_search')) {
        return {
          rows: [
            {
              paragraph_id: 'paragraph_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_index: 0,
              text: '"Hello."',
              paragraph: {
                id: 'paragraph_1',
                novelId: 'book_1',
                chapterId: 'chapter_1',
                index: 0,
                text: '"Hello."',
                startOffsetInChapter: 0,
                endOffsetInChapter: 8,
                textHash: 'stale_hash',
              },
            },
          ],
        };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from chapter_contexts') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (sql.includes('insert into labeled_segments')) {
        segments.push({ id: params?.[0] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into sync_events')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) return { rowCount: 1, rows: [] };
      if (sql.includes('select payload from character_')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => {
        throw new Error('sparse labels must fail before persistence transaction');
      }),
    } as unknown as pg.Pool;

    await expect(
      processProviderJob(pool, testConfig(), 'provider_job_invalid_labels', {
        createAIProvider: () => provider,
      }),
    ).rejects.toThrow(/Chapter labeling validation failed/);

    expect(jobRow.status).toBe('failed');
    expect(jobRow.stage).toBe('failed');
    expect(jobRow.progress).toMatchObject({
      failed: true,
      validation: { errorCount: 1, issueCodes: ['segment_text_hash_mismatch'] },
    });
    expect(segments).toEqual([]);
  });

  it('fails chapter labeling jobs before storage when quality rejects sparse dialogue labels', async () => {
    const paragraphs: Paragraph[] = Array.from({ length: 30 }, (_, index) => {
      const text = `"What happened ${index}?"`;
      return {
        id: `paragraph_${index}`,
        novelId: 'book_1',
        chapterId: 'chapter_1',
        index,
        text,
        startOffsetInChapter: index * 100,
        endOffsetInChapter: index * 100 + text.length,
        textHash: hashSync(text),
      };
    });
    const chapterCharacters = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
    const sparseSegments: LabeledSegment[] = paragraphs.slice(0, 2).map((paragraph, index) => ({
      id: `segment_${index}`,
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: paragraph.id,
      segmentIndex: index,
      startOffset: 0,
      endOffset: paragraph.text.length,
      segmentTextHash: paragraph.textHash,
      type: 'quoted_dialogue',
      speakerId: 'unknown',
      candidateSpeakers: [],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.75,
      isUserCorrected: false,
    }));
    const provider: AIProvider = {
      providerId: 'mock_sparse',
      displayName: 'Sparse Mock',
      labelChapterSegments: vi.fn(async () => ({ characters: [], segments: sparseSegments })),
    };
    const createAIProvider = vi.fn(() => provider);
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_sparse_labels',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock_sparse',
      model_id: 'mock-sparse-labeler-v1',
      input_hash: 'input_hash_sparse',
      status: 'queued',
      stage: 'queued',
      progress: {},
    };
    const segments: Record<string, unknown>[] = [];
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
      if (sql.trim().startsWith('update provider_jobs')) {
        if (sql.includes("and status = 'queued'")) {
          jobRow.status = 'running';
          jobRow.stage = 'loading_chapter';
          jobRow.progress = { ...(jobRow.progress as Record<string, unknown>), loaded: false };
          return { rowCount: 1, rows: [jobRow] };
        }
        const values = params ?? [];
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_chapter', 'labeling_segments', 'writing_results', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from chapters c')) {
        return {
          rows: [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter 1',
              text_hash: 'chapter_hash',
              raw_start_offset: 0,
              raw_end_offset: chapterCharacters,
              character_count: chapterCharacters,
              paragraph_count: paragraphs.length,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from paragraph_search')) {
        return {
          rows: paragraphs.map((paragraph) => ({
            paragraph_id: paragraph.id,
            book_id: paragraph.novelId,
            chapter_id: paragraph.chapterId,
            paragraph_index: paragraph.index,
            text: paragraph.text,
            paragraph,
          })),
        };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from chapter_contexts') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (sql.includes('insert into labeled_segments')) {
        segments.push({ id: params?.[0] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into sync_events')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) return { rowCount: 1, rows: [] };
      if (sql.includes('select payload from character_')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => {
        throw new Error('sparse labels must fail before persistence transaction');
      }),
    } as unknown as pg.Pool;

    await expect(
      processProviderJob(pool, testConfig(), 'provider_job_sparse_labels', { createAIProvider }),
    ).rejects.toThrow(/Chapter labeling quality failed/);

    expect(createAIProvider).toHaveBeenCalled();
    expect(jobRow.status).toBe('failed');
    expect(jobRow.stage).toBe('failed');
    expect(jobRow.progress).toMatchObject({
      failed: true,
      errorCategory: 'schema',
      validation: { errorCount: 28, issueCodes: ['missing_paragraph_result'] },
      quality: { errorCount: 2, issueCodes: ['dialogue_like_coverage_low', 'target_coverage_low'] },
    });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(segments).toEqual([]);
  });

  it('auto-repairs invalid chapter labeling output when explicitly enabled', async () => {
    const paragraphText = '"Hello."';
    const repairedHash = integrityHash(paragraphText);
    const invalidSegment: LabeledSegment = {
      id: 'segment_auto_repair',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_1',
      segmentIndex: 0,
      startOffset: 0,
      endOffset: paragraphText.length,
      segmentTextHash: 'stale_hash',
      type: 'quoted_dialogue',
      speakerId: 'unknown',
      candidateSpeakers: [],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.7,
      isUserCorrected: false,
    };
    const provider: AIProvider = {
      providerId: 'mock_repair',
      displayName: 'Repair Mock',
      takeExecutionMetadata: vi
        .fn()
        .mockReturnValueOnce({
          providerId: 'mock_repair',
          requestedModelId: 'mock-segment-labeler-v1',
          finishReason: 'STOP',
          latencyMs: 3,
          retryCount: 0,
        })
        .mockReturnValueOnce({
          providerId: 'mock_repair',
          requestedModelId: 'mock-segment-labeler-v1',
          finishReason: 'STOP',
          latencyMs: 4,
          retryCount: 0,
        }),
      labelChapterSegments: vi.fn(async () => ({ characters: [], segments: [invalidSegment] })),
      repairChapterLabels: vi.fn(async () => ({
        characters: [],
        segments: [{ ...invalidSegment, segmentTextHash: repairedHash }],
      })),
    };
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_auto_repair',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash_auto_repair',
      status: 'queued',
      stage: 'queued',
      progress: { providerOptions: { autoRepairOnValidationFailure: true } },
    };
    const segments: Record<string, unknown>[] = [];
    const analysisRuns: Record<string, unknown>[] = [];
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_chapter', 'labeling_segments', 'repairing_labels', 'writing_results', 'ready', 'failed'].includes(
            String(value),
          ),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from chapters c')) {
        return {
          rows: [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter 1',
              text_hash: 'chapter_hash',
              raw_start_offset: 0,
              raw_end_offset: paragraphText.length,
              character_count: paragraphText.length,
              paragraph_count: 1,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from paragraph_search')) {
        return {
          rows: [
            {
              paragraph_id: 'paragraph_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_index: 0,
              text: paragraphText,
              paragraph: {
                id: 'paragraph_1',
                novelId: 'book_1',
                chapterId: 'chapter_1',
                index: 0,
                text: paragraphText,
                startOffsetInChapter: 0,
                endOffsetInChapter: paragraphText.length,
                textHash: 'stale_hash',
              },
            },
          ],
        };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from chapter_contexts') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('insert into analysis_runs')) {
        analysisRuns.push({
          run_type: params?.[3],
          prompt_version: params?.[6],
          metadata: JSON.parse(String(params?.[9])),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into characters')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('delete from labeled_segments')) {
        segments.length = 0;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into labeled_segments')) {
        segments.push({
          id: params?.[0],
          segment_text_hash: params?.[7],
          speaker_id: params?.[9],
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into sync_events')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) return { rowCount: 1, rows: [] };
      if (sql.includes('select payload from character_')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = {
      query: handleQuery,
      release: vi.fn(),
    };
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_auto_repair', {
      createAIProvider: () => provider,
    });

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.stage).toBe('ready');
    expect(jobRow.progress).toMatchObject({
      providerOptions: { autoRepairOnValidationFailure: true },
      initialValidation: { errorCount: 1, issueCodes: ['segment_text_hash_mismatch'] },
      validation: { errorCount: 0 },
      autoRepair: {
        enabled: true,
        attempted: true,
        succeeded: true,
        requestProfileId: 'chapter-label-repair-v2-patch',
      },
      providerExecution: { providerId: 'mock_repair', latencyMs: 4 },
    });
    expect(analysisRuns).toHaveLength(1);
    expect(analysisRuns[0]).toMatchObject({
      run_type: 'chapter_segment_labeling',
      prompt_version: 'chapter-label-repair-v2-issue-patch',
      metadata: {
        labelingRequestProfileId: 'chapter-labeling-v2-strict-tts',
        labelingPromptVersion: 'chapter-labeler-v2-context-packet',
        requestProfileId: 'chapter-label-repair-v2-patch',
        autoRepair: { succeeded: true },
        initialProviderExecution: { providerId: 'mock_repair', latencyMs: 3 },
        providerExecution: { providerId: 'mock_repair', latencyMs: 4 },
      },
    });
    expect(segments).toEqual(expect.arrayContaining([expect.objectContaining({ segment_text_hash: repairedHash })]));
    expect(client.release).toHaveBeenCalled();
  });

  it('runs chapter label repair jobs against stored segments and persists revalidated output', async () => {
    const paragraphText = '"Hello."';
    const repairedHash = integrityHash(paragraphText);
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_repair_1',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_label_repair',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'repair_input_hash',
      status: 'queued',
      stage: 'queued',
      progress: { providerOptions: { repairRequestProfileId: 'chapter-label-repair-v1' } },
    };
    const segments: Record<string, unknown>[] = [];
    const analysisRuns: Record<string, unknown>[] = [];

    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_chapter', 'repairing_labels', 'writing_results', 'ready', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from chapters c')) {
        return {
          rows: [
            {
              id: 'chapter_1',
              book_id: 'book_1',
              chapter_index: 0,
              title: 'Chapter 1',
              text_hash: 'chapter_hash',
              raw_start_offset: 0,
              raw_end_offset: paragraphText.length,
              character_count: paragraphText.length,
              paragraph_count: 1,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from paragraph_search')) {
        return {
          rows: [
            {
              paragraph_id: 'paragraph_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_index: 0,
              text: paragraphText,
              paragraph: {
                id: 'paragraph_1',
                novelId: 'book_1',
                chapterId: 'chapter_1',
                index: 0,
                text: paragraphText,
                startOffsetInChapter: 0,
                endOffsetInChapter: paragraphText.length,
                textHash: repairedHash,
              },
            },
          ],
        };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from chapter_contexts') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (sql.includes('from labeled_segments') && sql.includes('order by segment_index asc')) {
        return {
          rows: [
            {
              id: 'segment_stale',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_id: 'paragraph_1',
              segment_index: 0,
              start_offset: 0,
              end_offset: paragraphText.length,
              segment_text_hash: 'stale_hash',
              segment_type: 'quoted_dialogue',
              speaker_id: 'unknown',
              candidate_speakers: [],
              listener_ids: [],
              emotion: 'neutral',
              confidence: 0.6,
              evidence: 'Stored stale segment.',
              voice_profile_id: null,
              is_user_corrected: false,
            },
          ],
        };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('insert into analysis_runs')) {
        analysisRuns.push({
          id: params?.[0],
          run_type: params?.[3],
          prompt_version: params?.[6],
          metadata: JSON.parse(String(params?.[9])),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('delete from labeled_segments')) {
        segments.length = 0;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into labeled_segments')) {
        segments.push({
          id: params?.[0],
          segment_text_hash: params?.[7],
          speaker_id: params?.[9],
          analysis_run_id: params?.[16],
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into sync_events')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('select payload from character_')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = {
      query: handleQuery,
      release: vi.fn(),
    };
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_repair_1');

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.stage).toBe('ready');
    expect(jobRow.progress).toMatchObject({
      providerOptions: { repairRequestProfileId: 'chapter-label-repair-v1' },
      existingSegmentCount: 1,
      inputValidation: { errorCount: 1, issueCodes: ['segment_text_hash_mismatch'] },
      validation: { errorCount: 0 },
      repaired: true,
    });
    expect(analysisRuns).toHaveLength(1);
    expect(analysisRuns[0]).toMatchObject({
      run_type: 'chapter_label_repair',
      prompt_version: 'chapter-label-repair-v1',
      metadata: {
        requestProfileId: 'chapter-label-repair-v1',
        schemaVersion: 'chapter-labeling-result-v1',
        inputValidation: { errorCount: 1 },
        validation: { errorCount: 0 },
        repaired: true,
      },
    });
    expect(segments).toEqual([
      expect.objectContaining({
        id: 'segment_stale',
        segment_text_hash: repairedHash,
        speaker_id: 'unknown',
      }),
    ]);
    expect(client.release).toHaveBeenCalled();
  });
});

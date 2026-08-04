import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { processProviderJob } from './provider-job-service.js';
import { hashSync } from '@noveldesk/text-core/legacy-hash';
import { capturedSyncEvent, testConfig } from './provider-jobs/provider-job-test-harness.js';

describe('provider job character graph and bundles', () => {
  it('consolidates graph jobs without collapsing identity candidates', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_graph_1',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_graph_merge',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash_graph',
      status: 'queued',
      stage: 'queued',
      progress: {
        providerOptions: { graphRequestProfileId: 'character-graph-merge-v1' },
        discoveredGraph: {
          novelId: 'book_1',
          characters: [
            {
              id: 'candidate_alex',
              canonicalName: 'Alex',
              aliases: ['Al'],
              color: '#3b82f6',
              description: 'Detected protagonist alias.',
              confidence: 0.72,
              isUserConfirmed: false,
            },
            {
              id: 'candidate_rin',
              canonicalName: 'Rin',
              aliases: ['R'],
              color: '#ef476f',
              description: 'Detected supporting character.',
              confidence: 0.68,
              isUserConfirmed: true,
            },
          ],
          relations: [
            {
              sourceCharacterId: 'candidate_alex',
              targetCharacterId: 'candidate_rin',
              relationLabel: 'mentor',
              termsUsedBySource: ['Rin'],
              termsUsedByTarget: ['Alex'],
              confidence: 0.66,
              evidence: ['chapter 1'],
            },
          ],
        },
        sourceContext: {
          bundleId: 'bundle_1',
          chapterIds: ['chapter_1'],
          summary: 'Initial graph merge.',
        },
      },
    };
    const characters: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
    const relations: Record<string, unknown>[] = [];
    const analysisRuns: Record<string, unknown>[] = [];
    const syncEvents: Record<string, unknown>[] = [];
    const books = new Map([['book_1', { analysis_status: 'queued' }]]);

    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_graph', 'merging_graph', 'writing_results', 'ready', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from characters')) {
        return {
          rows: [
            {
              id: 'char_alex',
              book_id: 'book_1',
              canonical_name: 'Alex',
              aliases: ['Al'],
              color: '#3b82f6',
              description: 'User confirmed protagonist.',
              confidence: 0.95,
              is_user_confirmed: true,
            },
          ],
        };
      }
      if (sql.includes('from character_relations')) {
        return { rows: [] };
      }
      if (sql.includes('from user_corrections')) {
        expect(params).toEqual(['book_1', null]);
        return {
          rows: [
            {
              id: 'correction_1',
              book_id: 'book_1',
              chapter_id: null,
              paragraph_id: null,
              segment_id: null,
              correction_type: 'speaker',
              before_json: { speakerId: 'candidate_alex' },
              after_json: { speakerId: 'char_alex' },
              apply_scope: 'global',
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
          run_type: params?.[2],
          prompt_version: params?.[5],
          output_hash: params?.[7],
          metadata: JSON.parse(String(params?.[8])),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into characters')) {
        characters.push({
          id: params?.[0],
          book_id: params?.[1],
          canonical_name: params?.[3],
          aliases: JSON.parse(String(params?.[4])),
          is_user_confirmed: params?.[8],
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('delete from character_aliases')) {
        aliases.length = 0;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into character_aliases')) {
        aliases.push({
          id: params?.[0],
          character_id: params?.[2],
          alias: params?.[3],
          alias_type: params?.[4],
          confidence: params?.[5],
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('delete from character_relations')) {
        relations.length = 0;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('insert into character_relations')) {
        relations.push({
          id: params?.[0],
          source_character_id: params?.[2],
          target_character_id: params?.[3],
          relation_label: params?.[4],
          terms_used_by_source: JSON.parse(String(params?.[5])),
          terms_used_by_target: JSON.parse(String(params?.[6])),
          confidence: params?.[7],
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

    await processProviderJob(pool, testConfig(), 'provider_job_graph_1');

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.stage).toBe('ready');
    expect(jobRow.progress).toMatchObject({
      providerOptions: { graphRequestProfileId: 'character-graph-merge-v1' },
      existingCharacterCount: 1,
      existingRelationCount: 0,
      discoveredCharacterCount: 2,
      discoveredRelationCount: 1,
      characterCount: 3,
      relationCount: 1,
      correctionCount: 1,
    });
    expect(analysisRuns).toHaveLength(1);
    expect(analysisRuns[0]).toMatchObject({
      run_type: 'character_graph_merge',
      prompt_version: 'character-graph-merge-v1',
      metadata: {
        requestProfileId: 'character-graph-merge-v1',
        schemaVersion: 'character-graph-v1',
        characterCount: 3,
        relationCount: 1,
      },
    });
    expect(characters.map((character) => character.id)).toEqual(
      expect.arrayContaining(['char_alex', 'candidate_alex', 'candidate_rin']),
    );
    expect(characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'char_alex', is_user_confirmed: true }),
        expect.objectContaining({ id: 'candidate_alex', is_user_confirmed: false }),
        expect.objectContaining({ id: 'candidate_rin', is_user_confirmed: false }),
      ]),
    );
    expect(aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ character_id: 'char_alex', alias: 'Alex', alias_type: 'canonical' }),
        expect.objectContaining({ character_id: 'char_alex', alias: 'Al' }),
        expect.objectContaining({ character_id: 'candidate_alex', alias: 'Alex', alias_type: 'canonical' }),
        expect.objectContaining({ character_id: 'candidate_rin', alias: 'Rin', alias_type: 'canonical' }),
      ]),
    );
    expect(relations).toEqual([
      expect.objectContaining({
        source_character_id: 'candidate_alex',
        target_character_id: 'candidate_rin',
        relation_label: 'mentor',
        terms_used_by_source: ['Rin'],
        terms_used_by_target: ['Alex'],
      }),
    ]);
    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0]).toMatchObject({
      type: 'character_graph_updated',
      book_id: 'book_1',
      entity_id: 'character_graph_book_1',
      payload: {
        mode: 'replace',
        characters: expect.arrayContaining([
          expect.objectContaining({ id: 'char_alex', isUserConfirmed: true }),
          expect.objectContaining({ id: 'candidate_alex', isUserConfirmed: false }),
          expect.objectContaining({ id: 'candidate_rin', isUserConfirmed: false }),
        ]),
        relations: expect.arrayContaining([
          expect.objectContaining({
            sourceCharacterId: 'candidate_alex',
            targetCharacterId: 'candidate_rin',
            relationLabel: 'mentor',
          }),
        ]),
      },
      revision: { entityType: 'character_graph', entityId: 'character_graph_book_1', novelId: 'book_1' },
    });
    expect(books.get('book_1')).toEqual({ analysis_status: 'mock_ready' });
    expect(client.release).toHaveBeenCalled();
  });

  it('fails graph merge jobs before persistence when provider returns an invalid graph', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_graph_invalid',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_graph_merge',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash_graph_invalid',
      status: 'queued',
      stage: 'queued',
      progress: {
        providerOptions: { graphRequestProfileId: 'character-graph-merge-v1' },
        discoveredGraph: {
          novelId: 'book_1',
          characters: [],
          relations: [],
        },
      },
    };
    const writes: string[] = [];
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) => ['loading_graph', 'merging_graph', 'failed'].includes(String(value)));
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        return { rowCount: 1, rows: [] };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (
        sql.includes('insert into analysis_runs') ||
        sql.includes('insert into characters') ||
        sql.includes('insert into character_aliases') ||
        sql.includes('insert into character_relations')
      ) {
        writes.push(sql);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => {
        throw new Error('graph persistence transaction should not start for invalid provider output');
      }),
    } as unknown as pg.Pool;

    await expect(
      processProviderJob(pool, testConfig(), 'provider_job_graph_invalid', {
        createAIProvider: () => ({
          providerId: 'mock',
          displayName: 'Invalid graph provider',
          labelChapterSegments: vi.fn(),
          mergeCharacterGraph: vi.fn(async () => ({
            novelId: 'book_1',
            characters: [
              {
                id: 'char_valid',
                novelId: 'book_1',
                canonicalName: 'Valid',
                aliases: [],
                color: '#3b82f6',
                confidence: 0.8,
                isUserConfirmed: true,
              },
            ],
            relations: [
              {
                id: 'rel_invalid',
                novelId: 'book_1',
                sourceCharacterId: 'char_valid',
                targetCharacterId: 'missing',
                relationLabel: 'knows',
                termsUsedBySource: [],
                termsUsedByTarget: [],
                confidence: 0.7,
                evidence: ['bad relation'],
              },
            ],
          })),
        }),
      }),
    ).rejects.toThrow('unknown target character');

    expect(jobRow.status).toBe('failed');
    expect(jobRow.stage).toBe('failed');
    expect(writes).toHaveLength(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('runs character bundle analysis jobs and stores discovered graph only in run metadata and job progress', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_bundle_1',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_bundle_analysis',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash_bundle',
      status: 'queued',
      stage: 'queued',
      progress: {
        providerOptions: { bundleRequestProfileId: 'character-bundle-analysis-v1' },
        sourceContext: {
          bundleId: 'bundle_1',
          chapterIds: ['chapter_1', 'chapter_2'],
          summary: 'Previous bundle summary.',
        },
      },
    };
    const analysisRuns: Record<string, unknown>[] = [];
    const tableWrites: string[] = [];
    const books = new Map([['book_1', { analysis_status: 'queued' }]]);

    const handleProgressUpdate = (params?: unknown[]) => {
      const values = params ?? [];
      if (values.includes('running')) jobRow.status = 'running';
      if (values.includes('succeeded')) jobRow.status = 'succeeded';
      if (values.includes('failed')) jobRow.status = 'failed';
      const stage = values.find((value) =>
        ['loading_bundle', 'analyzing_bundle', 'writing_results', 'ready', 'failed'].includes(String(value)),
      );
      if (stage) jobRow.stage = stage;
      const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
      if (progress) jobRow.progress = JSON.parse(String(progress));
    };

    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
        if (sql.trim().startsWith('update provider_jobs')) {
          handleProgressUpdate(params);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('from chapters c')) {
          return {
            rows: [
              {
                id: 'chapter_1',
                book_id: 'book_1',
                chapter_index: 1,
                title: 'Chapter 1',
                text_hash: 'chapter_hash_1',
                raw_start_offset: 0,
                raw_end_offset: 20,
                character_count: 20,
                paragraph_count: 1,
                created_at: '2026-07-06T00:00:00.000Z',
                updated_at: '2026-07-06T00:00:00.000Z',
              },
              {
                id: 'chapter_2',
                book_id: 'book_1',
                chapter_index: 2,
                title: 'Chapter 2',
                text_hash: 'chapter_hash_2',
                raw_start_offset: 21,
                raw_end_offset: 45,
                character_count: 24,
                paragraph_count: 1,
                created_at: '2026-07-06T00:10:00.000Z',
                updated_at: '2026-07-06T00:10:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from paragraph_search')) {
          const chapterId = String(params?.[0]);
          const text = chapterId === 'chapter_1' ? 'Alex called Blair Captain.' : 'Blair answered Alex.';
          return {
            rows: [
              {
                paragraph_id: `paragraph_${chapterId}`,
                book_id: 'book_1',
                chapter_id: chapterId,
                paragraph_index: 0,
                text,
                paragraph: {
                  id: `paragraph_${chapterId}`,
                  novelId: 'book_1',
                  chapterId,
                  index: 0,
                  text,
                  startOffsetInChapter: 0,
                  endOffsetInChapter: text.length,
                  textHash: hashSync(text),
                },
              },
            ],
          };
        }
        if (
          sql.includes('from characters') ||
          sql.includes('from character_relations') ||
          sql.includes('from user_corrections')
        ) {
          return { rows: [] };
        }
        throw new Error(`unexpected pool query: ${sql}`);
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
          if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
          if (sql.includes('insert into analysis_runs')) {
            const row = {
              id: params?.[0],
              book_id: params?.[1],
              run_type: params?.[2],
              provider_id: params?.[3],
              model_id: params?.[4],
              prompt_version: params?.[5],
              input_hash: params?.[6],
              output_hash: params?.[7],
              metadata: JSON.parse(String(params?.[8])),
            };
            analysisRuns.push(row);
            return { rowCount: 1, rows: [] };
          }
          if (
            sql.includes('insert into characters') ||
            sql.includes('insert into character_relations') ||
            sql.includes('insert into character_aliases')
          ) {
            tableWrites.push(sql);
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('update library_books set analysis_status')) {
            books.set(String(params?.[1]), { analysis_status: String(params?.[0]) });
            return { rowCount: 1, rows: [] };
          }
          if (sql.trim().startsWith('update provider_jobs')) {
            handleProgressUpdate(params);
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`unexpected client query: ${sql}`);
        }),
        release: vi.fn(),
      })),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_bundle_1', {
      createAIProvider: () => ({
        providerId: 'mock',
        displayName: 'Mock bundle provider',
        labelChapterSegments: vi.fn(),
        analyzeCharacterBundle: vi.fn(async () => ({
          novelId: 'book_1',
          bundleId: 'bundle_1',
          sourceChapterIds: ['chapter_1', 'chapter_2'],
          discoveredGraph: {
            novelId: 'book_1',
            characters: [
              {
                id: 'candidate_alex',
                novelId: 'book_1',
                canonicalName: 'Alex',
                aliases: ['Al'],
                color: '#3b82f6',
                confidence: 0.82,
                isUserConfirmed: false,
              },
              {
                id: 'candidate_blair',
                novelId: 'book_1',
                canonicalName: 'Blair',
                aliases: ['Captain'],
                color: '#ef476f',
                confidence: 0.8,
                isUserConfirmed: false,
              },
            ],
            relations: [
              {
                id: 'candidate_relation_1',
                novelId: 'book_1',
                sourceCharacterId: 'candidate_alex',
                targetCharacterId: 'candidate_blair',
                relationLabel: 'ally',
                termsUsedBySource: ['Captain'],
                termsUsedByTarget: [],
                confidence: 0.72,
                evidence: ['chapter_1: paragraph_1'],
              },
            ],
          },
          bundleSummaryForNext: 'Alex and Blair are likely allies.',
        })),
      }),
    });

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.stage).toBe('ready');
    expect(books.get('book_1')).toEqual({ analysis_status: 'needs_review' });
    expect(analysisRuns).toEqual([
      expect.objectContaining({
        run_type: 'character_bundle_analysis',
        prompt_version: 'character-bundle-analysis-v1',
        metadata: expect.objectContaining({
          bundleId: 'bundle_1',
          sourceChapterIds: ['chapter_1', 'chapter_2'],
          discoveredCharacterCount: 2,
          discoveredRelationCount: 1,
          bundleSummaryForNext: 'Alex and Blair are likely allies.',
          discoveredGraph: expect.objectContaining({
            novelId: 'book_1',
            characters: expect.arrayContaining([expect.objectContaining({ id: 'candidate_alex' })]),
          }),
        }),
      }),
    ]);
    expect(jobRow.progress).toEqual(
      expect.objectContaining({
        discoveredCharacterCount: 2,
        discoveredRelationCount: 1,
        bundleSummaryForNext: 'Alex and Blair are likely allies.',
        discoveredGraph: expect.objectContaining({ novelId: 'book_1' }),
      }),
    );
    expect(tableWrites).toHaveLength(0);
    expect(pool.connect).toHaveBeenCalled();
  });
});

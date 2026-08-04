import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { parseNovelFile } from '@noveldesk/text-core/parser';
import {
  applyHostedChapterStructure,
  previewHostedChapterStructure,
  rollbackHostedChapterStructure,
} from './hosted-chapter-structure-service.js';
import { getObjectBuffer } from './object-storage.js';

vi.mock('./object-storage.js', () => ({
  createS3Client: vi.fn(() => ({})),
  getObjectBuffer: vi.fn(),
}));

const config = { defaultUserId: 'user_1', s3: {} } as ServerConfig;

async function fixture() {
  const source = '1화 시작\n\n첫 문단입니다.\n\n둘째 문단입니다.\n\n2화 다음\n\n셋째 문단입니다.';
  const bytes = new TextEncoder().encode(source);
  const parsed = await parseNovelFile('hosted.txt', bytes.buffer, 'utf-8');
  const book = {
    id: parsed.novel.id,
    title: parsed.novel.title,
    active_content_revision_id: 'revision_1',
    content_revision_number: 1,
    revision_fence: 1,
    active_character_graph_revision_id: null,
    object_id: 'object_1',
    source_file_name: 'hosted.txt',
    source_encoding: 'utf-8',
    normalized_text_hash: parsed.novel.normalizedTextHash,
    analysis_status: 'not_analyzed',
    storage_key: 'user/object/hosted.txt',
    raw_text_hash: parsed.novel.rawTextHash,
    content_type: 'text/plain',
  };
  const chapters = parsed.chapters.map((chapter) => ({
    id: chapter.id,
    book_id: chapter.novelId,
    chapter_index: chapter.index,
    title: chapter.title,
    text_hash: chapter.textHash,
    raw_start_offset: chapter.rawStartOffset,
    raw_end_offset: chapter.rawEndOffset,
    character_count: chapter.characterCount,
    paragraph_count: chapter.paragraphCount,
    created_at: chapter.createdAt,
    updated_at: chapter.updatedAt,
  }));
  const pages = parsed.chapters.map((chapter) => ({
    id: `page_${chapter.id}`,
    book_id: chapter.novelId,
    chapter_id: chapter.id,
    page_index: 0,
    paragraphs: parsed.paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id),
  }));
  return { source, parsed, book, chapters, pages };
}

function queryHandler(
  data: Awaited<ReturnType<typeof fixture>>,
  draft?: Record<string, unknown>,
  receipt?: Record<string, unknown>,
  rowsByTable: Record<string, Record<string, unknown>[]> = {},
) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes('from chapter_structure_drafts') && draft) return { rows: [draft] };
    if (sql.includes('from chapter_structure_receipts') && receipt) return { rows: [receipt] };
    if (sql.includes('from library_books b') && sql.includes('join book_objects')) return { rows: [data.book] };
    if (sql.includes('select * from chapters')) return { rows: data.chapters };
    if (sql.includes('select * from paragraph_pages')) return { rows: data.pages };
    if (sql.includes('count(*)::text as count')) return { rows: [{ count: '0' }] };
    const table = sql.match(
      /select \* from (reading_positions|bookmarks|highlights|notes|labeled_segments|user_corrections|label_mutation_operations|label_mutation_invalidations|label_reanalysis_plans|tts_audio_cache|character_evidence_v2|character_mentions_v2)/,
    )?.[1];
    if (table) {
      return { rows: rowsByTable[table] ?? [] };
    }
    if (sql.includes('update library_books') && sql.includes('returning updated_at')) {
      return { rowCount: 1, rows: [{ updated_at: '2026-07-13T00:00:00.000Z' }] };
    }
    return { rows: [] };
  });
  return { query, calls };
}

describe('hosted chapter structure service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a bounded preview from the pinned source and active revision', async () => {
    const data = await fixture();
    vi.mocked(getObjectBuffer).mockResolvedValue({ body: Buffer.from(data.source), contentType: 'text/plain' });
    const handler = queryHandler(data);
    const pool = { query: handler.query } as unknown as pg.Pool;

    const preview = await previewHostedChapterStructure(pool, config, data.parsed.novel.id, [
      { kind: 'rename', chapterId: data.parsed.chapters[0].id, title: '변경 제목' },
    ]);

    expect(preview.baseContentRevisionId).toBe('revision_1');
    expect(preview.after[0].title).toBe('변경 제목');
    expect(handler.calls.some((sql) => sql.includes('insert into chapter_structure_drafts'))).toBe(true);
  });

  it('applies a draft inside one transaction and activates a new content revision', async () => {
    const data = await fixture();
    vi.mocked(getObjectBuffer).mockResolvedValue({ body: Buffer.from(data.source), contentType: 'text/plain' });
    const draft = {
      id: 'draft_1',
      book_id: data.parsed.novel.id,
      base_content_revision_id: 'revision_1',
      commands: [{ kind: 'rename', chapterId: data.parsed.chapters[0].id, title: '변경 제목' }],
    };
    const handler = queryHandler(data, draft);
    const client = { query: handler.query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    const receipt = await applyHostedChapterStructure(pool, config, 'draft_1');

    expect(receipt).toMatchObject({ draftId: 'draft_1', previousContentRevisionId: 'revision_1', status: 'active' });
    expect(receipt.contentRevisionId).not.toBe('revision_1');
    expect(handler.calls[0]).toBe('begin');
    expect(handler.calls.at(-1)).toBe('commit');
    expect(handler.calls.some((sql) => sql.includes('insert into chapter_structure_receipts'))).toBe(true);
    expect(handler.calls.some((sql) => sql.includes('insert into sync_events'))).toBe(true);
  });

  it('remaps durable labeling history and stales affected TTS cache without deleting all chapters', async () => {
    const data = await fixture();
    vi.mocked(getObjectBuffer).mockResolvedValue({ body: Buffer.from(data.source), contentType: 'text/plain' });
    const firstChapterId = data.parsed.chapters[0].id;
    const draft = {
      id: 'draft_split',
      book_id: data.parsed.novel.id,
      base_content_revision_id: 'revision_1',
      commands: [
        {
          kind: 'split',
          chapterId: firstChapterId,
          sourceOffset: data.source.indexOf('둘째 문단입니다.'),
          title: '분할된 화',
        },
      ],
    };
    const handler = queryHandler(data, draft, undefined, {
      label_mutation_operations: [{ id: 'operation_1', chapter_id: firstChapterId }],
      label_mutation_invalidations: [{ operation_id: 'operation_1', chapter_id: firstChapterId }],
      label_reanalysis_plans: [{ id: 'plan_1', chapter_id: firstChapterId, status: 'pending' }],
      tts_audio_cache: [{ id: 'cache_1', chapter_id: firstChapterId }],
    });
    const client = { query: handler.query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    await applyHostedChapterStructure(pool, config, 'draft_split');

    expect(handler.calls.some((sql) => sql === 'delete from chapters where book_id = $1')).toBe(false);
    expect(handler.calls.some((sql) => sql.includes('update label_mutation_operations set chapter_id'))).toBe(true);
    expect(handler.calls.some((sql) => sql.includes('update label_mutation_invalidations set chapter_id'))).toBe(true);
    expect(handler.calls.some((sql) => sql.includes('update label_reanalysis_plans'))).toBe(true);
    expect(handler.calls.some((sql) => sql.includes("lifecycle_state = 'stale'"))).toBe(true);
  });

  it('restores the receipt snapshot as a new revision when no newer edit exists', async () => {
    const data = await fixture();
    data.book.active_content_revision_id = 'revision_2';
    data.book.content_revision_number = 2;
    vi.mocked(getObjectBuffer).mockResolvedValue({ body: Buffer.from(data.source), contentType: 'text/plain' });
    const receipt = {
      id: 'receipt_1',
      book_id: data.parsed.novel.id,
      draft_id: 'draft_1',
      previous_content_revision_id: 'revision_1',
      content_revision_id: 'revision_2',
      commands: [{ kind: 'rename', chapterId: data.parsed.chapters[0].id, title: '변경 제목' }],
      previous_snapshot: { chapters: data.parsed.chapters, paragraphs: data.parsed.paragraphs },
      status: 'active',
      created_at: '2026-07-13T00:00:00.000Z',
    };
    const handler = queryHandler(data, undefined, receipt);
    const client = { query: handler.query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;

    const result = await rollbackHostedChapterStructure(pool, config, 'receipt_1');

    expect(result).toMatchObject({
      id: 'receipt_1',
      status: 'rolled_back',
      rollbackContentRevisionId: expect.any(String),
    });
    expect(handler.calls.at(-1)).toBe('commit');
    expect(handler.calls.some((sql) => sql.includes("set status = 'rolled_back'"))).toBe(true);
  });
});

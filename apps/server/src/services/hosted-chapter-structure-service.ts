import pg from 'pg';
import type { Chapter, Paragraph, ParagraphPage, UserCorrection } from '@noveldesk/contracts';
import {
  applyChapterStructureCommands,
  chapterStructureViews,
  type ChapterStructureCommand,
  type ChapterStructureSnapshot,
  type ChapterStructureTransformResult,
} from '@noveldesk/text-core/chapter-structure';
import { persistentId128 } from '@noveldesk/text-core/hash';
import { decodeNovelTextWithEncoding, normalizeNovelText } from '@noveldesk/text-core/parser';
import type { ServerConfig } from '../config.js';
import type {
  ChapterStructureEditorState,
  ChapterStructurePreview,
  ChapterStructureReceipt,
} from '../../../../src/repositories/chapter-structure-repository.js';
import { createS3Client, getObjectBuffer } from './object-storage.js';
import { insertChapterBatch, insertParagraphPageBatch, iterateChapterParagraphPages } from './import-service.js';
import { createServerRevision, insertServerSyncEvent } from '../routes/books/sync-event-repository.js';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

interface HostedBookRow extends pg.QueryResultRow {
  id: string;
  title: string;
  active_content_revision_id: string;
  content_revision_number: string | number;
  revision_fence: string | number;
  active_character_graph_revision_id: string | null;
  object_id: string;
  source_file_name: string;
  source_encoding: 'auto' | 'utf-8' | 'euc-kr' | null;
  normalized_text_hash: string;
  analysis_status: string;
  storage_key: string;
  raw_text_hash: string;
  content_type: string;
}

interface LoadedHostedStructure {
  readonly book: HostedBookRow;
  readonly snapshot: ChapterStructureSnapshot;
}

interface StoredStructureSnapshot {
  readonly chapters: Chapter[];
  readonly paragraphs: Paragraph[];
}

interface ReviewRow {
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: unknown;
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function chapterFromRow(row: Record<string, unknown>): Chapter {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    index: Number(row.chapter_index),
    title: String(row.title),
    normalizedText: '',
    textHash: String(row.text_hash),
    rawStartOffset: Number(row.raw_start_offset),
    rawEndOffset: Number(row.raw_end_offset),
    characterCount: Number(row.character_count),
    paragraphCount: Number(row.paragraph_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function paragraphArray(value: unknown): Paragraph[] {
  if (!Array.isArray(value)) throw new Error('Hosted paragraph page payload is invalid');
  return value as Paragraph[];
}

function snapshotPayload(
  snapshot: ChapterStructureSnapshot | ChapterStructureTransformResult,
): StoredStructureSnapshot {
  return { chapters: [...snapshot.chapters], paragraphs: [...snapshot.paragraphs] };
}

function paragraphsByChapter(paragraphs: readonly Paragraph[]): Map<string, Paragraph[]> {
  const result = new Map<string, Paragraph[]>();
  for (const paragraph of paragraphs) {
    const rows = result.get(paragraph.chapterId) ?? [];
    rows.push(paragraph);
    result.set(paragraph.chapterId, rows);
  }
  for (const rows of result.values()) rows.sort((left, right) => left.index - right.index);
  return result;
}

async function loadHostedStructure(
  queryable: Queryable,
  config: ServerConfig,
  bookId: string,
  lock = false,
): Promise<LoadedHostedStructure> {
  const result = await queryable.query<HostedBookRow>(
    `select b.id, b.title, b.active_content_revision_id, b.content_revision_number, b.revision_fence,
            b.active_character_graph_revision_id, b.object_id, b.source_file_name, b.source_encoding,
            b.normalized_text_hash, b.analysis_status,
            o.storage_key, o.raw_text_hash, o.content_type
     from library_books b
     join book_objects o on o.id = b.object_id
     where b.id = $1 and b.user_id = $2 and b.deleted_at is null
     ${lock ? 'for update of b' : ''}`,
    [bookId, config.defaultUserId],
  );
  const book = result.rows[0];
  if (!book?.active_content_revision_id) throw new Error('Book or active content revision was not found');
  const [chapterRows, pageRows, stored] = await Promise.all([
    queryable.query<Record<string, unknown>>('select * from chapters where book_id = $1 order by chapter_index', [
      bookId,
    ]),
    queryable.query<Record<string, unknown>>(
      'select * from paragraph_pages where book_id = $1 order by chapter_id, page_index',
      [bookId],
    ),
    getObjectBuffer(createS3Client(config), config, book.storage_key),
  ]);
  const decoded = decodeNovelTextWithEncoding(Uint8Array.from(stored.body).buffer, book.source_encoding ?? 'auto');
  const chapters = chapterRows.rows.map(chapterFromRow);
  const chapterOrder = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const paragraphs = pageRows.rows
    .sort(
      (left, right) =>
        (chapterOrder.get(String(left.chapter_id)) ?? 0) - (chapterOrder.get(String(right.chapter_id)) ?? 0) ||
        Number(left.page_index) - Number(right.page_index),
    )
    .flatMap((row) => paragraphArray(row.paragraphs))
    .sort(
      (left, right) =>
        (chapterOrder.get(left.chapterId) ?? 0) - (chapterOrder.get(right.chapterId) ?? 0) || left.index - right.index,
    );
  return {
    book,
    snapshot: {
      bookId,
      bookTitle: book.title,
      baseContentRevisionId: book.active_content_revision_id,
      sourceText: normalizeNovelText(decoded.text),
      chapters,
      paragraphs,
    },
  };
}

function paragraphMap(before: readonly Paragraph[], after: readonly Paragraph[]): ReadonlyMap<string, Paragraph> {
  const result = new Map<string, Paragraph>();
  const afterById = new Map(after.map((paragraph) => [paragraph.id, paragraph]));
  for (const paragraph of before) {
    const exact = afterById.get(paragraph.id);
    if (exact) result.set(paragraph.id, exact);
  }
  const candidates = new Map<string, Paragraph[]>();
  for (const paragraph of after) {
    const key = `${paragraph.textHash}\0${paragraph.text}`;
    const rows = candidates.get(key) ?? [];
    rows.push(paragraph);
    candidates.set(key, rows);
  }
  for (const paragraph of before) {
    if (result.has(paragraph.id)) continue;
    const matches = candidates.get(`${paragraph.textHash}\0${paragraph.text}`) ?? [];
    if (matches.length === 1) result.set(paragraph.id, matches[0]);
  }
  return result;
}

function chapterMap(
  before: readonly Chapter[],
  after: readonly Chapter[],
  paragraphsBefore: readonly Paragraph[],
  mapping: ReadonlyMap<string, Paragraph>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const afterIds = new Set(after.map((chapter) => chapter.id));
  const beforeParagraphs = paragraphsByChapter(paragraphsBefore);
  for (const chapter of before) {
    if (afterIds.has(chapter.id)) {
      result.set(chapter.id, chapter.id);
      continue;
    }
    const mapped = (beforeParagraphs.get(chapter.id) ?? []).map((paragraph) => mapping.get(paragraph.id)).find(Boolean);
    const fallback = after[Math.min(Math.max(0, chapter.index - 1), Math.max(0, after.length - 1))];
    const chapterId = mapped?.chapterId ?? fallback?.id;
    if (chapterId) result.set(chapter.id, chapterId);
  }
  return result;
}

function impact(
  before: ChapterStructureSnapshot,
  after: ChapterStructureTransformResult,
  annotationsAtRisk: number,
  correctionsForReview: number,
) {
  const mapping = paragraphMap(before.paragraphs, after.paragraphs);
  return {
    preservedParagraphs: mapping.size,
    addedParagraphs: after.paragraphs.length - new Set(mapping.values()).size,
    removedParagraphs: before.paragraphs.length - mapping.size,
    readerAnnotationsAtRisk: annotationsAtRisk,
    correctionsForReview,
  };
}

function structurallyChangedChapterIds(
  before: Pick<ChapterStructureSnapshot, 'chapters' | 'paragraphs'>,
  after: StoredStructureSnapshot,
): string[] {
  const paragraphFingerprint = (paragraphs: readonly Paragraph[], chapterId: string) =>
    paragraphs
      .filter((paragraph) => paragraph.chapterId === chapterId)
      .map((paragraph) => `${paragraph.index}:${paragraph.id}:${paragraph.textHash}`)
      .join('|');
  const beforeById = new Map(before.chapters.map((chapter) => [chapter.id, chapter]));
  const afterById = new Map(after.chapters.map((chapter) => [chapter.id, chapter]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  return [...ids].filter((id) => {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    if (!left || !right) return true;
    return (
      left.rawStartOffset !== right.rawStartOffset ||
      left.rawEndOffset !== right.rawEndOffset ||
      left.textHash !== right.textHash ||
      paragraphFingerprint(before.paragraphs, id) !== paragraphFingerprint(after.paragraphs, id)
    );
  });
}

async function atRiskCounts(queryable: Queryable, bookId: string, unmappedIds: readonly string[]) {
  if (unmappedIds.length === 0) return { annotations: 0, corrections: 0 };
  const [annotations, corrections] = await Promise.all([
    queryable.query<{ count: string }>(
      `select count(*)::text as count from (
         select id from bookmarks where book_id = $1 and deleted_at is null and paragraph_id = any($2::text[])
         union all select id from highlights where book_id = $1 and deleted_at is null and paragraph_id = any($2::text[])
         union all select id from notes where book_id = $1 and deleted_at is null and paragraph_id = any($2::text[])
       ) affected`,
      [bookId, unmappedIds],
    ),
    queryable.query<{ count: string }>(
      'select count(*)::text as count from user_corrections where book_id = $1 and paragraph_id = any($2::text[])',
      [bookId, unmappedIds],
    ),
  ]);
  return { annotations: Number(annotations.rows[0]?.count ?? 0), corrections: Number(corrections.rows[0]?.count ?? 0) };
}

function mapReceipt(row: Record<string, unknown>): ChapterStructureReceipt {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    draftId: String(row.draft_id),
    previousContentRevisionId: String(row.previous_content_revision_id),
    contentRevisionId: String(row.content_revision_id),
    commands: row.commands as ChapterStructureCommand[],
    status: row.status as ChapterStructureReceipt['status'],
    createdAt: iso(row.created_at),
    rolledBackAt: row.rolled_back_at ? iso(row.rolled_back_at) : undefined,
    rollbackContentRevisionId: row.rollback_content_revision_id ? String(row.rollback_content_revision_id) : undefined,
  };
}

export async function getHostedChapterStructureEditorState(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
): Promise<ChapterStructureEditorState> {
  const loaded = await loadHostedStructure(pool, config, bookId);
  const [receipts, review] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `select * from chapter_structure_receipts
       where book_id = $1 and user_id = $2 order by created_at desc limit 1`,
      [bookId, config.defaultUserId],
    ),
    pool.query<{ count: string }>(
      'select count(*)::text as count from chapter_structure_review_items where book_id = $1',
      [bookId],
    ),
  ]);
  return {
    bookId,
    baseContentRevisionId: loaded.snapshot.baseContentRevisionId,
    sourceProvenance: 'original',
    chapters: chapterStructureViews(loaded.snapshot),
    latestReceipt: receipts.rows[0] ? mapReceipt(receipts.rows[0]) : undefined,
    reviewItemCount: Number(review.rows[0]?.count ?? 0),
  };
}

export async function previewHostedChapterStructure(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
  commands: readonly ChapterStructureCommand[],
): Promise<ChapterStructurePreview> {
  if (commands.length === 0) throw new Error('At least one chapter structure command is required');
  const loaded = await loadHostedStructure(pool, config, bookId);
  const transformed = applyChapterStructureCommands(loaded.snapshot, commands);
  const mapping = paragraphMap(loaded.snapshot.paragraphs, transformed.paragraphs);
  const unmapped = loaded.snapshot.paragraphs.filter((paragraph) => !mapping.has(paragraph.id)).map((row) => row.id);
  const risk = await atRiskCounts(pool, bookId, unmapped);
  const createdAt = new Date().toISOString();
  const draftId = persistentId128('chapter_structure_draft', [
    bookId,
    loaded.snapshot.baseContentRevisionId,
    JSON.stringify(commands),
    createdAt,
  ]);
  const preview: ChapterStructurePreview = {
    draftId,
    bookId,
    baseContentRevisionId: loaded.snapshot.baseContentRevisionId,
    commands: [...commands],
    before: chapterStructureViews(loaded.snapshot),
    after: chapterStructureViews({
      ...loaded.snapshot,
      chapters: transformed.chapters,
      paragraphs: transformed.paragraphs,
    }),
    affectedChapterIds: transformed.affectedChapterIds,
    impact: impact(loaded.snapshot, transformed, risk.annotations, risk.corrections),
    warnings: [],
    createdAt,
  };
  await pool.query(
    `insert into chapter_structure_drafts
       (id, book_id, user_id, base_content_revision_id, commands, preview, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      draftId,
      bookId,
      config.defaultUserId,
      loaded.snapshot.baseContentRevisionId,
      JSON.stringify(commands),
      JSON.stringify(preview),
      createdAt,
    ],
  );
  return preview;
}

function pagesForStructure(chapters: readonly Chapter[], paragraphs: readonly Paragraph[]): ParagraphPage[] {
  const byChapter = paragraphsByChapter(paragraphs);
  return chapters.flatMap((chapter) => [...iterateChapterParagraphPages(chapter, byChapter.get(chapter.id) ?? [])]);
}

async function stageStructureChapters(client: pg.PoolClient, bookId: string, chapters: Chapter[]): Promise<void> {
  if (chapters.length === 0) throw new Error('Chapter structure cannot be empty');
  await client.query('delete from paragraph_search where book_id = $1', [bookId]);
  await client.query('delete from paragraph_pages where book_id = $1', [bookId]);
  await client.query('update chapters set chapter_index = -(chapter_index + 1) where book_id = $1', [bookId]);
  for (let start = 0; start < chapters.length; start += 100) {
    await insertChapterBatch(client, chapters.slice(start, start + 100));
  }
}

async function finishStructureContent(
  client: pg.PoolClient,
  bookId: string,
  chapters: Chapter[],
  paragraphs: Paragraph[],
): Promise<void> {
  await client.query('delete from chapters where book_id = $1 and not (id = any($2::text[]))', [
    bookId,
    chapters.map((chapter) => chapter.id),
  ]);
  const pages = pagesForStructure(chapters, paragraphs);
  for (let start = 0; start < pages.length; start += 25) {
    await insertParagraphPageBatch(client, pages.slice(start, start + 25));
  }
}

async function rawRows(client: pg.PoolClient, table: string, bookId: string): Promise<Record<string, unknown>[]> {
  const allowed = new Set([
    'reading_positions',
    'bookmarks',
    'highlights',
    'notes',
    'labeled_segments',
    'user_corrections',
    'label_mutation_operations',
    'label_mutation_invalidations',
    'label_reanalysis_plans',
    'tts_audio_cache',
    'character_evidence_v2',
    'character_mentions_v2',
  ]);
  if (!allowed.has(table)) throw new Error('Unsupported structure remap table');
  return (await client.query(`select * from ${table} where book_id = $1`, [bookId])).rows;
}

function reviewRow(
  receiptId: string,
  entityType: string,
  entityId: string,
  payload: unknown,
  kind = 'unmapped_after_structure_change',
): ReviewRow {
  return {
    id: persistentId128('chapter_structure_review', [receiptId, entityType, entityId]),
    kind,
    entityType,
    entityId,
    payload,
  };
}

async function replaceHostedStructure(
  client: pg.PoolClient,
  config: ServerConfig,
  loaded: LoadedHostedStructure,
  target: StoredStructureSnapshot,
  receiptId: string,
  affectedChapterIds: readonly string[],
): Promise<{ contentRevisionId: string; reviewRows: ReviewRow[] }> {
  const structuralChange = affectedChapterIds.length > 0;
  const [
    positions,
    bookmarks,
    highlights,
    notes,
    segments,
    corrections,
    mutationOperations,
    mutationInvalidations,
    reanalysisPlans,
    ttsCacheRows,
    characterEvidence,
    characterMentions,
  ] = await Promise.all([
    rawRows(client, 'reading_positions', loaded.book.id),
    rawRows(client, 'bookmarks', loaded.book.id),
    rawRows(client, 'highlights', loaded.book.id),
    rawRows(client, 'notes', loaded.book.id),
    rawRows(client, 'labeled_segments', loaded.book.id),
    rawRows(client, 'user_corrections', loaded.book.id),
    rawRows(client, 'label_mutation_operations', loaded.book.id),
    rawRows(client, 'label_mutation_invalidations', loaded.book.id),
    rawRows(client, 'label_reanalysis_plans', loaded.book.id),
    rawRows(client, 'tts_audio_cache', loaded.book.id),
    rawRows(client, 'character_evidence_v2', loaded.book.id),
    rawRows(client, 'character_mentions_v2', loaded.book.id),
  ]);
  const mapping = paragraphMap(loaded.snapshot.paragraphs, target.paragraphs);
  const chapters = chapterMap(loaded.snapshot.chapters, target.chapters, loaded.snapshot.paragraphs, mapping);
  const nextRevisionNumber = Number(loaded.book.content_revision_number) + 1;
  const contentRevisionId = persistentId128('book_content_revision', [
    loaded.book.id,
    loaded.book.active_content_revision_id,
    String(nextRevisionNumber),
    loaded.book.raw_text_hash,
    loaded.book.normalized_text_hash,
    receiptId,
  ]);
  await client.query(
    `insert into book_content_revisions (
       id, book_id, revision_number, source_object_id, source_raw_text_hash,
       normalized_text_hash, source_file_name, source_encoding, status, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'preparing', now())`,
    [
      contentRevisionId,
      loaded.book.id,
      nextRevisionNumber,
      loaded.book.object_id,
      loaded.book.raw_text_hash,
      loaded.book.normalized_text_hash,
      loaded.book.source_file_name,
      loaded.book.source_encoding,
    ],
  );

  await stageStructureChapters(client, loaded.book.id, target.chapters);
  const reviewRows: ReviewRow[] = [];
  const firstParagraph = target.paragraphs[0];
  const firstChapterId = target.chapters[0]?.id;
  const affected = new Set(affectedChapterIds);
  const affectedExistingIds = loaded.snapshot.chapters
    .map((chapter) => chapter.id)
    .filter((chapterId) => affected.has(chapterId));

  if (structuralChange) {
    await client.query(
      `update provider_jobs set status = 'cancelled', stage = 'stale', error_code = 'chapter_structure_changed',
         error_message = 'Chapter structure changed', finished_at = now(), updated_at = now()
       where book_id = $1 and status in ('queued', 'running')`,
      [loaded.book.id],
    );
    await client.query(
      `update book_ai_workflows set status = 'cancelled', stage = 'cancelled',
         error_code = 'chapter_structure_changed', error_message = 'Chapter structure changed',
         finished_at = now(), updated_at = now()
       where book_id = $1 and status in ('queued', 'running', 'needs_review')`,
      [loaded.book.id],
    );
    if (affectedExistingIds.length > 0) {
      await client.query(
        `update analysis_review_artifacts set status = 'obsolete', updated_at = now()
         where book_id = $1 and chapter_id = any($2::text[]) and status not in ('rejected', 'obsolete')`,
        [loaded.book.id, affectedExistingIds],
      );
      await client.query('delete from chapter_contexts where book_id = $1 and chapter_id = any($2::text[])', [
        loaded.book.id,
        affectedExistingIds,
      ]);
      await client.query('delete from tts_render_plans_v2 where book_id = $1 and chapter_id = any($2::text[])', [
        loaded.book.id,
        affectedExistingIds,
      ]);
      await client.query('delete from analysis_runs where book_id = $1 and chapter_id = any($2::text[])', [
        loaded.book.id,
        affectedExistingIds,
      ]);
    }
  }

  for (const row of mutationOperations) {
    const sourceChapterId = String(row.chapter_id);
    const chapterId = chapters.get(sourceChapterId) ?? firstChapterId;
    if (!chapterId) continue;
    await client.query('update label_mutation_operations set chapter_id = $1 where id = $2', [chapterId, row.id]);
  }
  for (const row of mutationInvalidations) {
    const sourceChapterId = String(row.chapter_id);
    const chapterId = chapters.get(sourceChapterId) ?? firstChapterId;
    if (!chapterId) continue;
    await client.query('update label_mutation_invalidations set chapter_id = $1 where operation_id = $2', [
      chapterId,
      row.operation_id,
    ]);
  }
  for (const row of reanalysisPlans) {
    const sourceChapterId = String(row.chapter_id);
    const chapterId = chapters.get(sourceChapterId) ?? firstChapterId;
    if (!chapterId) continue;
    await client.query(
      `update label_reanalysis_plans
       set chapter_id = $1,
           status = case when $2 and status in ('pending', 'queued', 'running') then 'cancelled' else status end,
           updated_at = now()
       where id = $3`,
      [chapterId, structuralChange && affected.has(sourceChapterId), row.id],
    );
  }

  if (structuralChange) {
    for (const row of ttsCacheRows) {
      const sourceChapterId = String(row.chapter_id);
      if (!affected.has(sourceChapterId)) continue;
      const chapterId = chapters.get(sourceChapterId) ?? firstChapterId;
      if (!chapterId) continue;
      await client.query(
        `update tts_audio_cache
         set chapter_id = $1, lifecycle_state = 'stale', stale_at = coalesce(stale_at, now()),
             gc_after = coalesce(gc_after, now() + interval '7 days'), updated_at = now()
         where id = $2`,
        [chapterId, row.id],
      );
    }
  }

  for (const row of characterEvidence) {
    const sourceChapterId = String(row.chapter_id);
    const paragraphId = row.paragraph_id ? String(row.paragraph_id) : undefined;
    const paragraph = paragraphId ? mapping.get(paragraphId) : undefined;
    const chapterId = paragraph?.chapterId ?? chapters.get(sourceChapterId);
    if (!chapterId || (paragraphId && !paragraph)) {
      if (affected.has(sourceChapterId))
        await client.query('delete from character_evidence_v2 where id = $1', [row.id]);
      continue;
    }
    await client.query(
      'update character_evidence_v2 set chapter_id = $1, paragraph_id = $2, updated_at = now() where id = $3',
      [chapterId, paragraph?.id ?? null, row.id],
    );
  }
  for (const row of characterMentions) {
    if (!row.chapter_id) continue;
    const chapterId = chapters.get(String(row.chapter_id));
    if (chapterId) {
      await client.query('update character_mentions_v2 set chapter_id = $1, updated_at = now() where id = $2', [
        chapterId,
        row.id,
      ]);
    }
  }

  for (const row of positions) {
    const oldParagraphId = row.paragraph_id ? String(row.paragraph_id) : undefined;
    const paragraph = oldParagraphId ? mapping.get(oldParagraphId) : undefined;
    const chapterId = paragraph?.chapterId ?? chapters.get(String(row.chapter_id)) ?? firstParagraph?.chapterId;
    if (!chapterId) {
      await client.query('delete from reading_positions where book_id = $1 and user_id = $2', [
        loaded.book.id,
        config.defaultUserId,
      ]);
      reviewRows.push(reviewRow(receiptId, 'reading_position', loaded.book.id, row));
      continue;
    }
    if (oldParagraphId && !paragraph) {
      reviewRows.push(
        reviewRow(receiptId, 'reading_position', loaded.book.id, row, 'relocated_after_structure_change'),
      );
    }
    const targetParagraph = paragraph ?? firstParagraph;
    await client.query(
      `update reading_positions set chapter_id = $1, paragraph_id = $2, paragraph_index = $3,
         offset_in_paragraph = least(offset_in_paragraph, $4), updated_at = now()
       where book_id = $5 and user_id = $6`,
      [
        chapterId,
        targetParagraph?.id ?? null,
        targetParagraph?.index ?? 0,
        targetParagraph?.text.length ?? 0,
        loaded.book.id,
        config.defaultUserId,
      ],
    );
  }

  for (const [table, rows] of [
    ['bookmarks', bookmarks],
    ['highlights', highlights],
    ['notes', notes],
  ] as const) {
    for (const row of rows) {
      const paragraphId = row.paragraph_id ? String(row.paragraph_id) : undefined;
      const paragraph = paragraphId ? mapping.get(paragraphId) : undefined;
      const chapterId = paragraph?.chapterId ?? chapters.get(String(row.chapter_id));
      if ((paragraphId && !paragraph) || !chapterId) {
        await client.query(`delete from ${table} where id = $1`, [row.id]);
        reviewRows.push(reviewRow(receiptId, table.slice(0, -1), String(row.id), row));
        continue;
      }
      await client.query(`update ${table} set chapter_id = $1, paragraph_id = $2, updated_at = now() where id = $3`, [
        chapterId,
        paragraph?.id ?? null,
        row.id,
      ]);
    }
  }

  const mappedSegmentIds = new Set<string>();
  for (const row of segments) {
    const sourceChapterId = String(row.chapter_id);
    const paragraph = mapping.get(String(row.paragraph_id));
    if (!paragraph) {
      if (affected.has(sourceChapterId)) await client.query('delete from labeled_segments where id = $1', [row.id]);
      continue;
    }
    const invalidateAnalysis =
      structuralChange && (affected.has(sourceChapterId) || sourceChapterId !== paragraph.chapterId);
    await client.query(
      `update labeled_segments
       set chapter_id = $1, paragraph_id = $2,
           analysis_run_id = case when $3 then null else analysis_run_id end,
           updated_at = now()
       where id = $4`,
      [paragraph.chapterId, paragraph.id, invalidateAnalysis, row.id],
    );
    mappedSegmentIds.add(String(row.id));
  }

  for (const row of corrections) {
    const paragraphId = row.paragraph_id ? String(row.paragraph_id) : undefined;
    const paragraph = paragraphId ? mapping.get(paragraphId) : undefined;
    const chapterId = paragraph?.chapterId ?? (row.chapter_id ? chapters.get(String(row.chapter_id)) : undefined);
    if ((paragraphId && !paragraph) || (row.chapter_id && !chapterId)) {
      await client.query('delete from user_corrections where id = $1', [row.id]);
      reviewRows.push(reviewRow(receiptId, 'user_correction', String(row.id), row));
      continue;
    }
    const segmentId = row.segment_id && mappedSegmentIds.has(String(row.segment_id)) ? row.segment_id : null;
    await client.query(
      `update user_corrections set chapter_id = $1, paragraph_id = $2, segment_id = $3 where id = $4`,
      [chapterId ?? null, paragraph?.id ?? null, segmentId, row.id],
    );
  }

  await finishStructureContent(client, loaded.book.id, target.chapters, target.paragraphs);
  const hasDurableAiArtifacts =
    segments.length > 0 || corrections.length > 0 || loaded.book.active_character_graph_revision_id;
  await client.query(
    `update book_content_revisions set status = 'superseded', superseded_at = now()
     where id = $1 and book_id = $2 and status = 'active'`,
    [loaded.snapshot.baseContentRevisionId, loaded.book.id],
  );
  await client.query(`update book_content_revisions set status = 'active', activated_at = now() where id = $1`, [
    contentRevisionId,
  ]);
  const activation = await client.query<{ updated_at: string | Date }>(
    `update library_books
     set active_content_revision_id = $1, content_revision_number = $2, revision_fence = revision_fence + 1,
         total_chapters = $3, total_paragraphs = $4, total_characters = $5,
         active_character_graph_revision_id = case when $6 then null else active_character_graph_revision_id end,
         analysis_status = case when $6 and $7 then 'needs_review' else analysis_status end,
         updated_at = now()
     where id = $8 and user_id = $9 and active_content_revision_id = $10
     returning updated_at`,
    [
      contentRevisionId,
      nextRevisionNumber,
      target.chapters.length,
      target.paragraphs.length,
      loaded.snapshot.sourceText.length,
      structuralChange,
      Boolean(hasDurableAiArtifacts),
      loaded.book.id,
      config.defaultUserId,
      loaded.snapshot.baseContentRevisionId,
    ],
  );
  if (activation.rowCount !== 1) throw new Error('Book content revision changed during chapter structure activation');
  const updatedAt = iso(activation.rows[0]?.updated_at ?? new Date());
  const syncPayload = { bookId: loaded.book.id, contentRevisionId };
  await insertServerSyncEvent(client, config.defaultUserId, {
    seed: `${receiptId}:${contentRevisionId}`,
    type: 'book_imported',
    bookId: loaded.book.id,
    entityId: loaded.book.id,
    payload: syncPayload,
    revision: createServerRevision({
      entityType: 'book',
      entityId: loaded.book.id,
      novelId: loaded.book.id,
      updatedAt,
      payload: syncPayload,
    }),
    createdAt: updatedAt,
  });
  return { contentRevisionId, reviewRows };
}

async function insertReviewRows(
  client: pg.PoolClient,
  bookId: string,
  receiptId: string,
  rows: readonly ReviewRow[],
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `insert into chapter_structure_review_items
         (id, book_id, receipt_id, item_kind, entity_type, entity_id, payload, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, now()) on conflict (id) do nothing`,
      [row.id, bookId, receiptId, row.kind, row.entityType, row.entityId, JSON.stringify(row.payload)],
    );
  }
}

export async function applyHostedChapterStructure(
  pool: pg.Pool,
  config: ServerConfig,
  draftId: string,
): Promise<ChapterStructureReceipt> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const draftResult = await client.query<Record<string, unknown>>(
      `select * from chapter_structure_drafts where id = $1 and user_id = $2 for update`,
      [draftId, config.defaultUserId],
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new Error('Chapter structure draft was not found');
    const bookId = String(draft.book_id);
    const loaded = await loadHostedStructure(client, config, bookId, true);
    if (loaded.snapshot.baseContentRevisionId !== String(draft.base_content_revision_id)) {
      throw new Error('Book content revision changed; create a new preview');
    }
    const commands = draft.commands as ChapterStructureCommand[];
    const transformed = applyChapterStructureCommands(loaded.snapshot, commands);
    const receiptId = persistentId128('chapter_structure_receipt', [draftId, loaded.snapshot.baseContentRevisionId]);
    const structuralChange = commands.some((command) => command.kind !== 'rename');
    const replacement = await replaceHostedStructure(
      client,
      config,
      loaded,
      snapshotPayload(transformed),
      receiptId,
      structuralChange ? transformed.affectedChapterIds : [],
    );
    const createdAt = new Date().toISOString();
    await client.query(
      `insert into chapter_structure_receipts (
         id, book_id, user_id, draft_id, previous_content_revision_id, content_revision_id,
         commands, previous_snapshot, next_snapshot, status, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)`,
      [
        receiptId,
        bookId,
        config.defaultUserId,
        draftId,
        loaded.snapshot.baseContentRevisionId,
        replacement.contentRevisionId,
        JSON.stringify(commands),
        JSON.stringify(snapshotPayload(loaded.snapshot)),
        JSON.stringify(snapshotPayload(transformed)),
        createdAt,
      ],
    );
    await insertReviewRows(client, bookId, receiptId, replacement.reviewRows);
    await client.query('delete from chapter_structure_drafts where id = $1', [draftId]);
    await client.query('commit');
    return {
      id: receiptId,
      bookId,
      draftId,
      previousContentRevisionId: loaded.snapshot.baseContentRevisionId,
      contentRevisionId: replacement.contentRevisionId,
      commands,
      status: 'active',
      createdAt,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function rollbackHostedChapterStructure(
  pool: pg.Pool,
  config: ServerConfig,
  receiptId: string,
): Promise<ChapterStructureReceipt> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const receiptResult = await client.query<Record<string, unknown>>(
      `select * from chapter_structure_receipts where id = $1 and user_id = $2 for update`,
      [receiptId, config.defaultUserId],
    );
    const row = receiptResult.rows[0];
    if (!row || row.status !== 'active') throw new Error('Active chapter structure receipt was not found');
    const bookId = String(row.book_id);
    const loaded = await loadHostedStructure(client, config, bookId, true);
    if (loaded.snapshot.baseContentRevisionId !== String(row.content_revision_id)) {
      throw new Error('A newer content revision prevents direct rollback');
    }
    const target = row.previous_snapshot as StoredStructureSnapshot;
    const commands = row.commands as ChapterStructureCommand[];
    const structuralChange = commands.some((command) => command.kind !== 'rename');
    const replacement = await replaceHostedStructure(
      client,
      config,
      loaded,
      target,
      receiptId,
      structuralChange ? structurallyChangedChapterIds(loaded.snapshot, target) : [],
    );
    const rolledBackAt = new Date().toISOString();
    await client.query(
      `update chapter_structure_receipts
       set status = 'rolled_back', rolled_back_at = $1, rollback_content_revision_id = $2
       where id = $3`,
      [rolledBackAt, replacement.contentRevisionId, receiptId],
    );
    await insertReviewRows(client, bookId, receiptId, replacement.reviewRows);
    await client.query('commit');
    return {
      ...mapReceipt({ ...row, status: 'rolled_back', rolled_back_at: rolledBackAt }),
      rollbackContentRevisionId: replacement.contentRevisionId,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listHostedChapterStructureReview(pool: pg.Pool, config: ServerConfig, bookId: string) {
  const result = await pool.query<Record<string, unknown>>(
    `select item.id, item.book_id, item.receipt_id, item.item_kind, item.entity_type, item.entity_id,
            item.payload, item.created_at
     from chapter_structure_review_items item
     join library_books book on book.id = item.book_id
     where item.book_id = $1 and book.user_id = $2 order by item.created_at desc`,
    [bookId, config.defaultUserId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    bookId: String(row.book_id),
    receiptId: String(row.receipt_id),
    kind:
      row.entity_type === 'user_correction' ? ('correction_unmapped' as const) : ('reader_anchor_unmapped' as const),
    correction: row.entity_type === 'user_correction' ? (row.payload as UserCorrection) : undefined,
    payload: row.payload,
    createdAt: iso(row.created_at),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
  }));
}

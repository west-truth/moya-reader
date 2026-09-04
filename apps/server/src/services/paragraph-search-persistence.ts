import type pg from 'pg';
import type { Paragraph, ParagraphPage } from '@noveldesk/contracts';
import { persistentId128 } from '@noveldesk/text-core/hash';

const MAX_PARAGRAPH_SEARCH_ROWS_PER_INSERT = 3_000;
const RESTORE_PARAGRAPH_PAGE_BATCH_SIZE = 25;

export type ParagraphSearchPage = Pick<ParagraphPage, 'novelId' | 'chapterId' | 'pageIndex' | 'paragraphs'>;

function storedParagraphPage(row: Record<string, unknown>): ParagraphPage {
  const paragraphs = row.paragraphs;
  if (!Array.isArray(paragraphs)) throw new Error('Backup paragraph page content is invalid');
  for (const paragraph of paragraphs) {
    if (
      !paragraph ||
      typeof paragraph !== 'object' ||
      Array.isArray(paragraph) ||
      typeof (paragraph as Record<string, unknown>).id !== 'string' ||
      typeof (paragraph as Record<string, unknown>).index !== 'number' ||
      typeof (paragraph as Record<string, unknown>).text !== 'string'
    ) {
      throw new Error('Backup paragraph content is invalid');
    }
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.book_id !== 'string' ||
    typeof row.chapter_id !== 'string' ||
    typeof row.page_index !== 'number' ||
    typeof row.start_paragraph_index !== 'number' ||
    typeof row.end_paragraph_index !== 'number' ||
    typeof row.text_hash !== 'string'
  ) {
    throw new Error('Backup paragraph page metadata is invalid');
  }
  return {
    id: row.id,
    novelId: row.book_id,
    chapterId: row.chapter_id,
    pageIndex: row.page_index,
    startParagraphIndex: row.start_paragraph_index,
    endParagraphIndex: row.end_paragraph_index,
    paragraphs: paragraphs as Paragraph[],
    textHash: row.text_hash,
  };
}

function insertRows(
  client: pg.PoolClient,
  paragraphs: readonly { page: ParagraphSearchPage; paragraph: Paragraph }[],
): Promise<pg.QueryResult> {
  const values: unknown[] = [];
  const rows = paragraphs.map(({ page, paragraph }) => {
    const offset = values.length;
    values.push(
      persistentId128('paragraph_search', [page.novelId, page.chapterId, paragraph.id]),
      paragraph.id,
      page.novelId,
      page.chapterId,
      page.pageIndex,
      paragraph.index,
      paragraph.text,
      paragraph.text.toLowerCase(),
      JSON.stringify(paragraph),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
  });

  return client.query(
    `
      insert into paragraph_search (
        id, paragraph_id, book_id, chapter_id, page_index, paragraph_index, text, text_lower, paragraph
      )
      values ${rows.join(', ')}
      on conflict (id) do update
        set paragraph_id = excluded.paragraph_id,
            book_id = excluded.book_id,
            chapter_id = excluded.chapter_id,
            page_index = excluded.page_index,
            paragraph_index = excluded.paragraph_index,
            text = excluded.text,
            text_lower = excluded.text_lower,
            paragraph = excluded.paragraph,
            updated_at = now()
    `,
    values,
  );
}

export async function insertParagraphSearchBatch(
  client: pg.PoolClient,
  pages: readonly ParagraphSearchPage[],
): Promise<number> {
  const paragraphs = pages.flatMap((page) =>
    page.paragraphs.map((paragraph) => ({
      page,
      paragraph,
    })),
  );

  for (let start = 0; start < paragraphs.length; start += MAX_PARAGRAPH_SEARCH_ROWS_PER_INSERT) {
    await insertRows(client, paragraphs.slice(start, start + MAX_PARAGRAPH_SEARCH_ROWS_PER_INSERT));
  }

  return paragraphs.length;
}

export async function rebuildParagraphSearchFromStoredPages(
  client: pg.PoolClient,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const pages = rows.map(storedParagraphPage);
  let expectedParagraphs = 0;
  for (let start = 0; start < pages.length; start += RESTORE_PARAGRAPH_PAGE_BATCH_SIZE) {
    expectedParagraphs += await insertParagraphSearchBatch(
      client,
      pages.slice(start, start + RESTORE_PARAGRAPH_PAGE_BATCH_SIZE),
    );
  }
  const restoredBookIds = [...new Set(pages.map((page) => page.novelId))];
  const result = await client.query<{ count: string }>(
    'select count(*)::text as count from paragraph_search where book_id = any($1::text[])',
    [restoredBookIds],
  );
  if (Number(result.rows[0]?.count ?? -1) !== expectedParagraphs) {
    throw new Error('Backup paragraph search index could not be restored completely');
  }
}

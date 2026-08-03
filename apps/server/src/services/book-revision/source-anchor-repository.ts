import type pg from 'pg';

export interface ExactParagraphSourceAnchor {
  readonly contentRevisionId: string;
  readonly anchor: {
    readonly kind: 'paragraph';
    readonly chapterIndex: number;
    readonly paragraphIndex: number;
    readonly paragraphId: string;
    readonly textHash: string;
  };
  readonly hash: string;
}

export async function resolveExactParagraphSourceAnchor(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  bookId: string,
  paragraphId: string,
): Promise<ExactParagraphSourceAnchor | undefined> {
  const result = await db.query<{
    active_content_revision_id: string;
    chapter_index: number | string;
    paragraph_index: number | string;
    paragraph_id: string;
    text_hash: string;
  }>(
    `
      select book.active_content_revision_id,
             chapter.chapter_index,
             paragraph.paragraph_index,
             paragraph.paragraph_id,
             coalesce(paragraph.paragraph->>'textHash', paragraph.paragraph->>'text_hash', '') as text_hash
      from paragraph_search paragraph
      join chapters chapter on chapter.id = paragraph.chapter_id and chapter.book_id = paragraph.book_id
      join library_books book on book.id = paragraph.book_id
      where paragraph.book_id = $1
        and paragraph.paragraph_id = $2
        and book.user_id = $3
    `,
    [bookId, paragraphId, userId],
  );
  const row = result.rows[0];
  if (!row?.active_content_revision_id || !row.text_hash) return undefined;
  return {
    contentRevisionId: row.active_content_revision_id,
    anchor: {
      kind: 'paragraph',
      chapterIndex: Number(row.chapter_index),
      paragraphIndex: Number(row.paragraph_index),
      paragraphId: row.paragraph_id,
      textHash: row.text_hash,
    },
    hash: row.text_hash,
  };
}

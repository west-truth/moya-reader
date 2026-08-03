import pg from 'pg';
import type { ServerConfig } from '../../config.js';

export async function hasBookChapterAccess(
  pool: Pick<pg.Pool, 'query'>,
  config: ServerConfig,
  bookId: string,
  chapterId: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
      select exists(
        select 1
        from chapters c
        join library_books b on b.id = c.book_id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null and c.id = $3
      ) as exists
    `,
    [bookId, config.defaultUserId, chapterId],
  );
  return result.rows[0]?.exists === true;
}

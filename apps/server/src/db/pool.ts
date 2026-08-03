import pg from 'pg';
import { ServerConfig } from '../config.js';

const { Pool } = pg;

export function createPool(config: ServerConfig): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });
}

export async function seedDefaultUser(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query(
    `
      insert into users (id, email, display_name)
      values ($1, $2, $3)
      on conflict (id) do nothing
    `,
    [userId, 'reader@localhost', 'Local Reader'],
  );
}

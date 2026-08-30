import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relativeUrl: string): Promise<string> {
  return (await readFile(new URL(relativeUrl, import.meta.url), 'utf8')).toLowerCase();
}

describe('tokenless reused-id policy', () => {
  it('uses the persistent generation ledger across canonical mutation boundaries', async () => {
    const [catalog, cover, libraryManagement, purge] = await Promise.all([
      source('../routes/books/catalog-routes.ts'),
      source('../routes/books/cover-routes.ts'),
      source('./hosted-library-management-service.ts'),
      source('./hosted-book-purge.ts'),
    ]);

    for (const implementation of [catalog, cover, libraryManagement, purge]) {
      expect(implementation).toContain('book_id_generations');
      expect(implementation).toContain('generation > 1');
    }
    expect(purge).not.toContain("type = 'book_purged'");
  });

  it('keeps purge timestamps only for temporal sync ordering', async () => {
    const policy = await source('../routes/sync/revision-conflict-policy.ts');

    expect(policy.match(/book_id_generations/g)?.length).toBe(2);
    expect(policy).toContain('identity.generation > 1');
    expect(policy).toContain('purge.created_at >= $3::timestamptz');
    expect(policy).toContain('select max(purge.created_at) from sync_events purge');
  });
});

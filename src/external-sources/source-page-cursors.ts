import { randomUuid } from '../utils/random-uuid';
import type { ExternalItemPage, ExternalSourceListInput } from './contracts';
import { sourceListIdentity } from './cache-policy';
/** A cursor can only append to the source/query generation that produced its first page. */
export class SourcePageCursors {
  private snapshots = new Map<string, { query: string; expires: number }>();
  private prefix = 'moya-cache:';
  open(source: string, generation: string | undefined, input: ExternalSourceListInput) {
    const { cursor, ...identity } = sourceListIdentity(input);
    const query = JSON.stringify([source, generation, identity]);
    if (!cursor?.startsWith(this.prefix)) return { query, cursor, token: undefined };
    try {
      const [token, raw] = JSON.parse(decodeURIComponent(cursor.slice(this.prefix.length))) as unknown[];
      if (typeof token !== 'string' || typeof raw !== 'string') throw new Error();
      this.assert(token, query);
      return { query, cursor: raw, token };
    } catch {
      throw new Error('source_catalog_changed');
    }
  }
  assert(token: string, query: string) {
    const saved = this.snapshots.get(token);
    if (!saved || saved.query !== query || saved.expires <= Date.now()) throw new Error('source_catalog_changed');
  }
  page(page: ExternalItemPage, query: string, token: string | undefined, first: boolean, keep: number) {
    if (token) this.assert(token, query);
    if (first) {
      for (const [id, saved] of this.snapshots)
        if (saved.query === query || saved.expires <= Date.now()) this.snapshots.delete(id);
      if (page.nextCursor) {
        token = randomUuid();
        if (this.snapshots.size >= 1000) this.snapshots.delete(this.snapshots.keys().next().value!);
        this.snapshots.set(token, { query, expires: Date.now() + keep });
      }
    }
    if (!page.nextCursor || !token) return page;
    return { ...page, nextCursor: this.prefix + encodeURIComponent(JSON.stringify([token, page.nextCursor])) };
  }
  clear() {
    this.snapshots.clear();
  }
}

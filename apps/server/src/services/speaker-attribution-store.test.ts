import { textIntegrityHash } from '@noveldesk/text-core/hash';
import { buildSpeakerSourceManifest, type SpeakerSourceParagraphInput } from '@noveldesk/text-core/speaker-attribution';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { backfillCharacterGraphKnowledgeV2 } from '../../../../src/providers/character-graph-v2';
import { buildSpeakerAttributionChapter } from '../../../../src/providers/speaker-attribution/inventory-builder';
import { loadMigrations } from '../db/migrate.js';
import {
  getHostedSpeakerAttributionChapterInventory,
  getHostedSpeakerSourceManifest,
  putHostedSpeakerSourceManifestInTransaction,
  replaceHostedSpeakerAttributionChapterInventoryInTransaction,
  type SpeakerAttributionQueryable,
} from './speaker-attribution-store.js';

function result<T extends pg.QueryResultRow>(rows: T[]): pg.QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

class MemorySpeakerAttributionDb implements SpeakerAttributionQueryable {
  readonly queries: string[] = [];
  private manifest?: unknown;
  private meta?: unknown;
  private readonly rows = new Map<string, unknown[]>();

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    this.queries.push(text);
    if (text.includes('speaker-attribution:ownership')) return result([{ allowed: true }] as unknown as T[]);
    if (text.includes('speaker-attribution:upsert-manifest')) {
      this.manifest = JSON.parse(String(values[6]));
      return result([] as T[]);
    }
    if (text.includes('speaker-attribution:load-manifest')) {
      return result((this.manifest ? [{ payload: this.manifest }] : []) as unknown as T[]);
    }
    if (text.includes('speaker-attribution:delete-chapter')) {
      this.meta = undefined;
      this.rows.clear();
      return result([] as T[]);
    }
    if (text.includes('speaker-attribution:insert-chapter')) {
      this.meta = JSON.parse(String(values[7]));
      return result([] as T[]);
    }
    const insertKinds: Readonly<Record<string, string>> = {
      'speaker-attribution:insert-scenes': 'speaker_scenes',
      'speaker-attribution:insert-spans': 'speaker_spans',
      'speaker-attribution:insert-bursts': 'speaker_dialogue_bursts',
      'speaker-attribution:insert-mentions': 'speaker_mentions',
      'speaker-attribution:insert-entities': 'speaker_entities',
      'speaker-attribution:insert-address-events': 'speaker_address_events',
    };
    for (const [marker, table] of Object.entries(insertKinds)) {
      if (!text.includes(marker)) continue;
      this.rows.set(table, JSON.parse(String(values[4])) as unknown[]);
      return result([] as T[]);
    }
    if (text.includes('speaker-attribution:load-chapter')) {
      return result((this.meta ? [{ payload: this.meta }] : []) as unknown as T[]);
    }
    const table = /select\s+payload\s+from\s+(speaker_[a-z_]+)/iu.exec(text)?.[1];
    if (table) return result((this.rows.get(table) ?? []).map((payload) => ({ payload })) as unknown as T[]);
    throw new Error(`Unexpected speaker attribution query: ${text}`);
  }

  serializedRows(): string {
    return JSON.stringify({ manifest: this.manifest, meta: this.meta, rows: Object.fromEntries(this.rows) });
  }
}

function paragraphs(): SpeakerSourceParagraphInput[] {
  const texts = ['“안녕.”', '“왔어?”', '민준이 말했다.'];
  let offset = 0;
  return texts.map((text, paragraphIndex) => {
    const startOffsetInChapter = offset;
    offset += text.length + 2;
    return {
      paragraphId: `paragraph_${paragraphIndex}`,
      chapterId: 'chapter_1',
      paragraphIndex,
      text,
      textHash: textIntegrityHash(text),
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
    };
  });
}

describe('hosted speaker attribution persistence', () => {
  it('round-trips normalized chapter rows without duplicating span text', async () => {
    const db = new MemorySpeakerAttributionDb();
    const inventory = buildSpeakerAttributionChapter({
      bookId: 'book_1',
      contentRevisionId: 'content_revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs: paragraphs(),
      characters: [],
      graphKnowledge: backfillCharacterGraphKnowledgeV2({ novelId: 'book_1', characters: [], relations: [] }),
      maxTargetSpansPerBurst: 1,
    }).inventory;

    await replaceHostedSpeakerAttributionChapterInventoryInTransaction(db, 'user_1', inventory);
    const loaded = await getHostedSpeakerAttributionChapterInventory(db, 'user_1', 'content_revision_1', 'chapter_1');

    expect(loaded).toEqual(inventory);
    expect(db.serializedRows()).not.toContain('안녕');
    expect(db.queries.filter((query) => query.includes('speaker-attribution:insert-'))).toHaveLength(7);
  });

  it('persists manifest review status and keeps migration numbering contiguous', async () => {
    const db = new MemorySpeakerAttributionDb();
    const source = paragraphs()
      .map((paragraph) => paragraph.text)
      .join('\n\n');
    const manifest = buildSpeakerSourceManifest({
      bookId: 'book_1',
      contentRevisionId: 'content_revision_1',
      activeContentRevisionId: 'content_revision_1',
      sourceHash: 'sha256:source',
      normalizedText: source,
      normalizedTextHash: textIntegrityHash(source),
      expectedChapterCount: 90,
      chapters: [
        {
          chapterId: 'chapter_1',
          chapterIndex: 1,
          sourceStartOffset: 0,
          sourceEndOffset: source.length,
          bodyStartOffset: 0,
          bodyEndOffset: source.length,
          text: source,
          textHash: textIntegrityHash(source),
          paragraphCount: 3,
        },
      ],
    });
    await putHostedSpeakerSourceManifestInTransaction(db, 'user_1', manifest);

    expect(await getHostedSpeakerSourceManifest(db, 'user_1', 'content_revision_1')).toEqual(manifest);
    expect(manifest.status).toBe('review_required');
    expect((await loadMigrations()).at(-1)?.fileName).toBe('0035_fixed_document_section_read_states.sql');
  });
});

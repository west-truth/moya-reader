import 'fake-indexeddb/auto';
import { buildSpeakerSourceManifest, type SpeakerSourceParagraphInput } from '@noveldesk/text-core/speaker-attribution';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillCharacterGraphKnowledgeV2 } from '../providers/character-graph-v2';
import { buildSpeakerAttributionChapter } from '../providers/speaker-attribution/inventory-builder';
import { BOOK_DATA_STORES, deleteBookDataInTransaction } from './book-data-cleanup';
import { transactionDone } from './indexeddb-transaction';
import { openReaderDb, READER_DB_VERSION, resetReaderDbForTests } from './reader-database';
import { SPEAKER_ATTRIBUTION_STORES } from './speaker-attribution-schema';
import {
  clearSpeakerAttributionRevision,
  getSpeakerAttributionChapterInventory,
  getSpeakerSourceManifest,
  putSpeakerSourceManifest,
  replaceSpeakerAttributionChapterInventory,
} from './speaker-attribution-store';

const bookId = 'book_1';
const contentRevisionId = 'content_revision_1';
const chapterId = 'chapter_1';

function paragraphs(): SpeakerSourceParagraphInput[] {
  const texts = ['“안녕.”', '“왔어?”', '민준이 말했다.'];
  let offset = 0;
  return texts.map((text, paragraphIndex) => {
    const startOffsetInChapter = offset;
    offset += text.length + 2;
    return {
      paragraphId: `paragraph_${paragraphIndex}`,
      chapterId,
      paragraphIndex,
      text,
      textHash: textIntegrityHash(text),
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
    };
  });
}

function build(maxTargetSpansPerBurst: number) {
  return buildSpeakerAttributionChapter({
    bookId,
    contentRevisionId,
    chapterId,
    chapterIndex: 1,
    paragraphs: paragraphs(),
    characters: [],
    graphKnowledge: backfillCharacterGraphKnowledgeV2({ novelId: bookId, characters: [], relations: [] }),
    maxTargetSpansPerBurst,
  }).inventory;
}

describe('speaker attribution IndexedDB persistence', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('upgrades the current schema and atomically replaces one chapter derived inventory', async () => {
    const source = paragraphs()
      .map((paragraph) => paragraph.text)
      .join('\n\n');
    const manifest = buildSpeakerSourceManifest({
      bookId,
      contentRevisionId,
      activeContentRevisionId: contentRevisionId,
      sourceHash: 'sha256:source',
      normalizedText: source,
      normalizedTextHash: textIntegrityHash(source),
      chapters: [
        {
          chapterId,
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
    await putSpeakerSourceManifest(manifest);
    const first = build(20);
    const replacement = build(1);
    await replaceSpeakerAttributionChapterInventory(first);
    await replaceSpeakerAttributionChapterInventory(replacement);

    const db = await openReaderDb();
    expect(db.version).toBe(READER_DB_VERSION);
    expect([...Object.values(SPEAKER_ATTRIBUTION_STORES)].every((name) => db.objectStoreNames.contains(name))).toBe(
      true,
    );
    expect(await getSpeakerSourceManifest(contentRevisionId)).toEqual(manifest);
    expect(await getSpeakerAttributionChapterInventory(contentRevisionId, chapterId)).toEqual(replacement);
    expect(replacement.dialogueBurstInventory.bursts).toHaveLength(2);

    const tx = db.transaction(SPEAKER_ATTRIBUTION_STORES.dialogueBursts, 'readonly');
    const storedBursts = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore(SPEAKER_ATTRIBUTION_STORES.dialogueBursts).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(storedBursts).toHaveLength(2);

    const purgeTx = db.transaction([...BOOK_DATA_STORES], 'readwrite');
    const purgeDone = transactionDone(purgeTx);
    deleteBookDataInTransaction(purgeTx, bookId);
    await purgeDone;
    expect(await getSpeakerSourceManifest(contentRevisionId)).toBeUndefined();
    expect(await getSpeakerAttributionChapterInventory(contentRevisionId, chapterId)).toBeUndefined();

    await replaceSpeakerAttributionChapterInventory(replacement);
    await clearSpeakerAttributionRevision(contentRevisionId);
    expect(await getSpeakerAttributionChapterInventory(contentRevisionId, chapterId)).toBeUndefined();
  });
});

import { normalizeNovelText } from '@noveldesk/text-core/normalization';
import { decodeNovelTextWithEncoding } from '@noveldesk/text-core/parser';
import type { EncodingMode } from '@noveldesk/contracts';
import { integrityHash } from '@noveldesk/text-core/hash';
import {
  HASH_V2_CONTRACT,
  ID_V2_CONTRACT,
  IdV2MigrationError,
  type BookSourceLoader,
  type IdV2IdentityFactory,
  type SourceBookObject,
} from './contracts.js';
import type { BookSnapshotRows } from './book-snapshot.js';
import { AliasRegistry } from './alias-registry.js';
import { verifiedCanonicalHash } from './hash-validation.js';
import { HashAliasRegistry } from './hash-alias-registry.js';
import { integerValue, optionalText, record, textValue, type JsonRecord } from './safe-values.js';

const validEncodings = new Set<EncodingMode>(['auto', 'utf-8', 'euc-kr']);

export interface CoreMigrationPlan {
  readonly aliases: AliasRegistry;
  readonly hashAliases: HashAliasRegistry;
  readonly canonicalRows: BookSnapshotRows;
  readonly sourceBookId: string;
  readonly canonicalBookId: string;
  readonly sourceObjectId: string;
  readonly canonicalObjectId: string;
  readonly sourceFileName: string;
  readonly sourceNormalizedTextHash: string;
  readonly canonicalNormalizedTextHash: string;
  readonly canonicalRawTextHash: string;
  readonly normalizedText: string;
  readonly paragraphTextBySourceId: ReadonlyMap<string, string>;
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function sourceObject(row: JsonRecord): SourceBookObject {
  return {
    id: textValue(row.id, 'book_objects.id'),
    rawTextHash: textValue(row.raw_text_hash, 'book_objects.raw_text_hash'),
    storageKey: textValue(row.storage_key, 'book_objects.storage_key'),
    fileName: textValue(row.file_name, 'book_objects.file_name'),
    contentType: textValue(row.content_type, 'book_objects.content_type'),
    sizeBytes: integerValue(row.size_bytes, 'book_objects.size_bytes'),
  };
}

async function loadVerifiedSource(
  rows: BookSnapshotRows,
  sourceLoader: BookSourceLoader,
): Promise<{
  source: SourceBookObject;
  normalizedText: string;
  canonicalRawTextHash: string;
  canonicalNormalizedTextHash: string;
}> {
  const book = rows.library_books[0];
  const objectRow = rows.book_objects[0];
  if (!objectRow) {
    throw new IdV2MigrationError('source_object_missing', 'The source object is required for exact ID migration.');
  }
  const source = sourceObject(objectRow);
  let body: Buffer;
  try {
    body = await sourceLoader.load(source);
  } catch {
    throw new IdV2MigrationError('source_object_unavailable', 'The source object could not be loaded.');
  }
  if (body.byteLength !== source.sizeBytes) {
    throw new IdV2MigrationError('source_object_size_mismatch', 'The source object size does not match metadata.');
  }

  const encodingValue = optionalText(book.source_encoding) ?? 'auto';
  const encoding = validEncodings.has(encodingValue as EncodingMode) ? (encodingValue as EncodingMode) : 'auto';
  const decoded = decodeNovelTextWithEncoding(arrayBuffer(body), encoding);
  const normalizedText = normalizeNovelText(decoded.text);
  const canonicalRawTextHash = verifiedCanonicalHash(source.rawTextHash, body, 'book_object');
  const canonicalNormalizedTextHash = verifiedCanonicalHash(
    textValue(book.normalized_text_hash, 'library_books.normalized_text_hash'),
    normalizedText,
    'normalized_book_text',
  );
  return { source, normalizedText, canonicalRawTextHash, canonicalNormalizedTextHash };
}

function cloneEmptyRows(rows: BookSnapshotRows): BookSnapshotRows {
  return Object.fromEntries(Object.keys(rows).map((key) => [key, []])) as unknown as BookSnapshotRows;
}

function chapterBody(normalizedText: string, chapter: JsonRecord): string {
  const start = integerValue(chapter.raw_start_offset, 'chapters.raw_start_offset');
  const end = integerValue(chapter.raw_end_offset, 'chapters.raw_end_offset');
  if (start < 0 || end < start || end > normalizedText.length) {
    throw new IdV2MigrationError('chapter_range_invalid', 'A chapter source range is invalid.', {
      entityType: 'chapter',
      sourceId: optionalText(chapter.id),
    });
  }
  return normalizedText.slice(start, end);
}

export async function buildCoreMigrationPlan(input: {
  readonly rows: BookSnapshotRows;
  readonly identities: IdV2IdentityFactory;
  readonly sourceLoader: BookSourceLoader;
  readonly runId: string;
}): Promise<CoreMigrationPlan> {
  const book = input.rows.library_books[0];
  const sourceBookId = textValue(book.id, 'library_books.id');
  const sourceFileName = textValue(book.source_file_name, 'library_books.source_file_name');
  const sourceNormalizedTextHash = textValue(book.normalized_text_hash, 'library_books.normalized_text_hash');
  const verifiedSource = await loadVerifiedSource(input.rows, input.sourceLoader);
  const canonicalBookId = input.identities.book(sourceFileName, verifiedSource.canonicalNormalizedTextHash);
  const canonicalObjectId = input.identities.object(verifiedSource.canonicalRawTextHash);
  const aliases = new AliasRegistry();
  const hashAliases = new HashAliasRegistry();
  aliases.add('book', sourceBookId, canonicalBookId);
  aliases.add('object', verifiedSource.source.id, canonicalObjectId);
  hashAliases.add(verifiedSource.source.rawTextHash, verifiedSource.canonicalRawTextHash);
  hashAliases.add(sourceNormalizedTextHash, verifiedSource.canonicalNormalizedTextHash);

  const canonicalRows = cloneEmptyRows(input.rows);
  canonicalRows.book_objects.push({
    ...input.rows.book_objects[0],
    id: canonicalObjectId,
    raw_text_hash: verifiedSource.canonicalRawTextHash,
    id_contract: ID_V2_CONTRACT,
    hash_contract: HASH_V2_CONTRACT,
  });
  canonicalRows.library_books.push({
    ...book,
    id: canonicalBookId,
    object_id: canonicalObjectId,
    normalized_text_hash: verifiedSource.canonicalNormalizedTextHash,
    id_contract: ID_V2_CONTRACT,
    hash_contract: HASH_V2_CONTRACT,
    identity_migration_run_id: input.runId,
  });

  const canonicalChapterBySource = new Map<string, JsonRecord>();
  for (const chapter of [...input.rows.chapters].sort(
    (left, right) =>
      integerValue(left.chapter_index, 'chapter_index') - integerValue(right.chapter_index, 'chapter_index'),
  )) {
    const sourceId = textValue(chapter.id, 'chapters.id');
    const chapterIndex = integerValue(chapter.chapter_index, 'chapters.chapter_index');
    const title = textValue(chapter.title, 'chapters.title');
    const body = chapterBody(verifiedSource.normalizedText, chapter);
    const canonicalId = input.identities.chapter(canonicalBookId, chapterIndex, title);
    const canonicalTextHash = verifiedCanonicalHash(
      textValue(chapter.text_hash, 'chapters.text_hash'),
      body,
      'chapter',
    );
    aliases.add('chapter', sourceId, canonicalId);
    hashAliases.add(textValue(chapter.text_hash, 'chapters.text_hash'), canonicalTextHash);
    const canonical = {
      ...chapter,
      id: canonicalId,
      book_id: canonicalBookId,
      text_hash: canonicalTextHash,
    };
    canonicalRows.chapters.push(canonical);
    canonicalChapterBySource.set(sourceId, canonical);
  }

  const paragraphBySource = new Map<string, JsonRecord>();
  const paragraphTextBySourceId = new Map<string, string>();
  for (const page of [...input.rows.paragraph_pages].sort(
    (left, right) => integerValue(left.page_index, 'page_index') - integerValue(right.page_index, 'page_index'),
  )) {
    const sourcePageId = textValue(page.id, 'paragraph_pages.id');
    const sourceChapterId = textValue(page.chapter_id, 'paragraph_pages.chapter_id');
    const canonicalChapterId = aliases.require('chapter', sourceChapterId);
    const pageIndex = integerValue(page.page_index, 'paragraph_pages.page_index');
    if (!Array.isArray(page.paragraphs)) {
      throw new IdV2MigrationError('page_json_invalid', 'A paragraph page is malformed.', {
        entityType: 'page',
        sourceId: sourcePageId,
      });
    }
    const canonicalParagraphs = page.paragraphs.map((value, arrayIndex) => {
      const paragraph = record(value, 'paragraph page item');
      const sourceParagraphId = textValue(paragraph.id, 'paragraph.id');
      const paragraphIndex = integerValue(paragraph.index, 'paragraph.index');
      const text = textValue(paragraph.text, 'paragraph.text');
      const canonicalTextHash = verifiedCanonicalHash(
        textValue(paragraph.textHash, 'paragraph.textHash'),
        text,
        'paragraph',
      );
      const canonicalParagraphId = input.identities.paragraph(
        canonicalBookId,
        canonicalChapterId,
        Math.max(0, paragraphIndex - 1),
        text,
      );
      aliases.add('paragraph', sourceParagraphId, canonicalParagraphId);
      hashAliases.add(textValue(paragraph.textHash, 'paragraph.textHash'), canonicalTextHash);
      const canonical = {
        ...paragraph,
        id: canonicalParagraphId,
        novelId: canonicalBookId,
        chapterId: canonicalChapterId,
        index: paragraphIndex,
        textHash: canonicalTextHash,
      };
      if (paragraphBySource.has(sourceParagraphId)) {
        throw new IdV2MigrationError('paragraph_duplicate', 'A paragraph appears in more than one page.', {
          entityType: 'paragraph',
          sourceId: sourceParagraphId,
        });
      }
      paragraphBySource.set(sourceParagraphId, canonical);
      paragraphTextBySourceId.set(sourceParagraphId, text);
      if (
        arrayIndex > 0 &&
        paragraphIndex <=
          integerValue(
            (page.paragraphs as unknown[])[arrayIndex - 1] &&
              record((page.paragraphs as unknown[])[arrayIndex - 1], 'paragraph').index,
            'paragraph.index',
          )
      ) {
        throw new IdV2MigrationError('paragraph_order_invalid', 'Paragraph indexes are not strictly increasing.', {
          entityType: 'page',
          sourceId: sourcePageId,
        });
      }
      return canonical;
    });
    const canonicalPageId = input.identities.page(canonicalBookId, canonicalChapterId, pageIndex);
    aliases.add('page', sourcePageId, canonicalPageId);
    const sourcePageHashInput = JSON.stringify(
      (page.paragraphs as unknown[]).map((value) =>
        textValue(record(value, 'paragraph').textHash, 'paragraph.textHash'),
      ),
    );
    const sourcePageHash = textValue(page.text_hash, 'paragraph_pages.text_hash');
    verifiedCanonicalHash(sourcePageHash, sourcePageHashInput, 'page');
    const canonicalPageHash = integrityHash(JSON.stringify(canonicalParagraphs.map((paragraph) => paragraph.textHash)));
    hashAliases.add(sourcePageHash, canonicalPageHash);
    canonicalRows.paragraph_pages.push({
      ...page,
      id: canonicalPageId,
      book_id: canonicalBookId,
      chapter_id: canonicalChapterId,
      paragraphs: canonicalParagraphs,
      text_hash: canonicalPageHash,
    });
  }

  for (const search of input.rows.paragraph_search) {
    const sourceId = textValue(search.id, 'paragraph_search.id');
    const sourceParagraphId = textValue(search.paragraph_id, 'paragraph_search.paragraph_id');
    const canonicalParagraph = paragraphBySource.get(sourceParagraphId);
    if (!canonicalParagraph) {
      throw new IdV2MigrationError('search_paragraph_missing', 'A search row has no source paragraph.', {
        entityType: 'paragraph_search',
        sourceId,
      });
    }
    const canonicalChapterId = aliases.require('chapter', textValue(search.chapter_id, 'paragraph_search.chapter_id'));
    const canonicalId = input.identities.paragraphSearch(
      canonicalBookId,
      canonicalChapterId,
      textValue(canonicalParagraph.id, 'paragraph.id'),
    );
    aliases.add('paragraph_search', sourceId, canonicalId);
    canonicalRows.paragraph_search.push({
      ...search,
      id: canonicalId,
      paragraph_id: canonicalParagraph.id,
      book_id: canonicalBookId,
      chapter_id: canonicalChapterId,
      paragraph: canonicalParagraph,
    });
  }

  const expectedChapters = integerValue(book.total_chapters, 'library_books.total_chapters');
  const expectedParagraphs = integerValue(book.total_paragraphs, 'library_books.total_paragraphs');
  if (canonicalRows.chapters.length !== expectedChapters || paragraphBySource.size !== expectedParagraphs) {
    throw new IdV2MigrationError('content_count_mismatch', 'Stored content counts do not match book metadata.', {
      expectedCount: { chapters: expectedChapters, paragraphs: expectedParagraphs },
      actualCount: { chapters: canonicalRows.chapters.length, paragraphs: paragraphBySource.size },
    });
  }

  return {
    aliases,
    hashAliases,
    canonicalRows,
    sourceBookId,
    canonicalBookId,
    sourceObjectId: verifiedSource.source.id,
    canonicalObjectId,
    sourceFileName,
    sourceNormalizedTextHash,
    canonicalNormalizedTextHash: verifiedSource.canonicalNormalizedTextHash,
    canonicalRawTextHash: verifiedSource.canonicalRawTextHash,
    normalizedText: verifiedSource.normalizedText,
    paragraphTextBySourceId,
  };
}

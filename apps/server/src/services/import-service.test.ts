import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { paragraphPageId, parsedChapterId, parsedParagraphId } from '@noveldesk/text-core/identity/parser';
import type { ParagraphPage, ParsedNovel, ParsedNovelImport } from '@noveldesk/contracts';
import { readSeriesImageArchiveManifest } from '@noveldesk/fixed-document-core/series-image-archive';
import type { ServerConfig } from '../config.js';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';

vi.mock('./object-storage.js', () => ({
  createS3Client: vi.fn(() => ({})),
  getObjectBuffer: vi.fn(),
  putRawBookObject: vi.fn(async () => undefined),
}));

import { getObjectBuffer, putRawBookObject } from './object-storage.js';

import {
  arrayBufferFromBuffer,
  buildParagraphPages,
  iterateImportParagraphPageBatches,
  iterateImportParagraphPageBatchesAsync,
  iterateParagraphPageBatches,
  normalizeCoverSeedForPersistence,
  processImportJob,
  rekeyParsedNovel,
  rekeyParsedNovelImport,
  replaceParsedBookContent,
} from './import-service.js';

function parsedNovel(): ParsedNovel {
  const now = '2026-07-05T00:00:00.000Z';
  return {
    novel: {
      id: 'server-import-book',
      title: 'Server Import Book',
      sourceFileName: 'server-import-book.txt',
      sourceEncoding: 'utf-8',
      rawText: '',
      normalizedText: '',
      rawTextHash: 'raw',
      normalizedTextHash: 'normalized',
      createdAt: now,
      updatedAt: now,
      totalChapters: 2,
      totalCharacters: 6,
      totalParagraphs: 3,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: 'chapter-1',
        novelId: 'server-import-book',
        index: 1,
        title: '1화',
        normalizedText: '',
        textHash: 'chapter-1-hash',
        rawStartOffset: 0,
        rawEndOffset: 2,
        characterCount: 2,
        paragraphCount: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'chapter-2',
        novelId: 'server-import-book',
        index: 2,
        title: '2화',
        normalizedText: '',
        textHash: 'chapter-2-hash',
        rawStartOffset: 3,
        rawEndOffset: 6,
        characterCount: 3,
        paragraphCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs: [
      {
        id: 'paragraph-2',
        novelId: 'server-import-book',
        chapterId: 'chapter-1',
        index: 2,
        text: '둘',
        startOffsetInChapter: 2,
        endOffsetInChapter: 3,
        textHash: 'paragraph-2-hash',
      },
      {
        id: 'paragraph-3',
        novelId: 'server-import-book',
        chapterId: 'chapter-2',
        index: 1,
        text: '셋',
        startOffsetInChapter: 0,
        endOffsetInChapter: 1,
        textHash: 'paragraph-3-hash',
      },
      {
        id: 'paragraph-1',
        novelId: 'server-import-book',
        chapterId: 'chapter-1',
        index: 1,
        text: '하나',
        startOffsetInChapter: 0,
        endOffsetInChapter: 1,
        textHash: 'paragraph-1-hash',
      },
    ],
  };
}

function parsedNovelImport(): ParsedNovelImport {
  const parsed = parsedNovel();
  let consumed = false;
  return {
    novel: {
      ...parsed.novel,
      rawText: '',
      normalizedText: '',
    },
    chapters: parsed.chapters.map((chapter) => ({ ...chapter, normalizedText: '' })),
    *consumeChapterParagraphs() {
      if (consumed) return;
      consumed = true;
      for (const chapter of parsed.chapters) {
        yield {
          chapter,
          paragraphs: parsed.paragraphs
            .filter((paragraph) => paragraph.chapterId === chapter.id)
            .sort((a, b) => a.index - b.index),
        };
      }
    },
  };
}

function parsedNovelAsyncImport(): ParsedNovelImport {
  const parsed = parsedNovel();
  let consumed = false;
  return {
    novel: {
      ...parsed.novel,
      rawText: '',
      normalizedText: '',
    },
    chapters: parsed.chapters.map((chapter) => ({ ...chapter, normalizedText: '' })),
    consumeChapterParagraphs() {
      if (consumed) return [];
      consumed = true;
      return (async function* () {
        for (const chapter of parsed.chapters) {
          await Promise.resolve();
          yield {
            chapter,
            paragraphs: parsed.paragraphs
              .filter((paragraph) => paragraph.chapterId === chapter.id)
              .sort((a, b) => a.index - b.index),
          };
        }
      })();
    },
  };
}

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

async function singlePageComicArchive(): Promise<Buffer> {
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('001.png', new Uint8ArrayReader(png));
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

async function twoReleaseSeriesComicArchive(): Promise<Buffer> {
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const firstPage = 'chapters/000001/00001.png';
  const secondPage = 'chapters/000002/00001.png';
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add(firstPage, new Uint8ArrayReader(png));
  await writer.add(secondPage, new Uint8ArrayReader(png));
  await writer.add(
    'moya-series.json',
    new TextReader(
      JSON.stringify({
        schemaVersion: 1,
        collection: { remoteId: 'manga:41', title: '연재 작품' },
        chapters: [
          {
            remoteId: 'chapter:101',
            title: '1화',
            pageCount: 1,
            entryNames: [firstPage],
          },
          {
            remoteId: 'chapter:102',
            title: '2화',
            pageCount: 1,
            entryNames: [secondPage],
          },
        ],
      }),
    ),
  );
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

async function seriesComicArchive(
  chapters: readonly { readonly remoteId: string; readonly title: string; readonly sourceContentHash: string }[],
): Promise<Buffer> {
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  const manifestChapters = [];
  for (const [index, chapter] of chapters.entries()) {
    const entryName = `chapters/${String(index + 1).padStart(6, '0')}/00001.png`;
    await writer.add(entryName, new Uint8ArrayReader(png));
    manifestChapters.push({
      ...chapter,
      chapterNumber: index + 1,
      sourceOrder: index + 1,
      pageCount: 1,
      entryNames: [entryName],
    });
  }
  await writer.add(
    'moya-series.json',
    new TextReader(
      JSON.stringify({
        schemaVersion: 1,
        collection: { remoteId: 'manga:41', title: '연재 작품' },
        chapters: manifestChapters,
      }),
    ),
  );
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

describe('server import service', () => {
  it('normalizes visual cover seeds before writing PostgreSQL integer columns', () => {
    expect(normalizeCoverSeedForPersistence(0xffff_ffff)).toBe(2_147_483_647);
    expect(normalizeCoverSeedForPersistence(0x8000_0000)).toBe(0);
    expect(normalizeCoverSeedForPersistence(Number.NaN)).toBe(0);
  });

  it('reuses an exact Buffer backing store when passing upload bytes to the parser', () => {
    const buffer = Buffer.allocUnsafeSlow(32);
    buffer.fill(7);

    const arrayBuffer = arrayBufferFromBuffer(buffer);

    expect(arrayBuffer).toBe(buffer.buffer);
    expect(new Uint8Array(arrayBuffer)).toEqual(new Uint8Array(buffer));
  });

  it('slices pooled Buffer backing stores before passing upload bytes to the parser', () => {
    const source = Buffer.from('prefix본문suffix');
    const buffer = source.subarray(6, source.length - 6);

    const arrayBuffer = arrayBufferFromBuffer(buffer);

    expect(arrayBuffer).not.toBe(source.buffer);
    expect(new TextDecoder().decode(arrayBuffer)).toBe('본문');
  });

  it('builds paragraph pages grouped and sorted by chapter', () => {
    const pages = buildParagraphPages(parsedNovel());

    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.chapterId)).toEqual(['chapter-1', 'chapter-2']);
    expect(pages[0]).toMatchObject({
      id: paragraphPageId('server-import-book', 'chapter-1', 0),
      pageIndex: 0,
      startParagraphIndex: 1,
      endParagraphIndex: 2,
    });
    expect(pages[0].textHash).toBe(integrityHash(JSON.stringify(['paragraph-1-hash', 'paragraph-2-hash'])));
    expect(pages[0].paragraphs.map((paragraph) => paragraph.id)).toEqual(['paragraph-1', 'paragraph-2']);
    expect(pages[1].paragraphs.map((paragraph) => paragraph.id)).toEqual(['paragraph-3']);
  });

  it('iterates paragraph page batches in insert order', () => {
    const batches = Array.from(iterateParagraphPageBatches(parsedNovel(), 1));

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.map((page) => page.chapterId))).toEqual([['chapter-1'], ['chapter-2']]);
    expect(batches.flat().flatMap((page) => page.paragraphs.map((paragraph) => paragraph.id))).toEqual([
      'paragraph-1',
      'paragraph-2',
      'paragraph-3',
    ]);
  });

  it('rekeys parsed imports to a client supplied book id for local attach uploads', () => {
    const parsed = parsedNovel();
    const rekeyed = rekeyParsedNovel(parsed, 'novel_local_attach');
    const pages = buildParagraphPages(rekeyed);

    expect(rekeyed.novel.id).toBe('novel_local_attach');
    expect(rekeyed.novel.lastReadChapterId).toBe(rekeyed.chapters[0].id);
    expect(rekeyed.chapters.every((chapter) => chapter.novelId === 'novel_local_attach')).toBe(true);
    expect(rekeyed.paragraphs.every((paragraph) => paragraph.novelId === 'novel_local_attach')).toBe(true);
    expect(new Set(rekeyed.chapters.map((chapter) => chapter.id))).not.toContain('chapter-1');
    expect(pages.every((page) => page.novelId === 'novel_local_attach')).toBe(true);
    expect(pages.map((page) => page.chapterId)).toEqual(rekeyed.chapters.map((chapter) => chapter.id));
    expect(rekeyed.paragraphs.map((paragraph) => paragraph.text).sort()).toEqual(['둘', '셋', '하나']);
    expect(rekeyed.chapters[0].id).toBe(parsedChapterId('novel_local_attach', 1, rekeyed.chapters[0].title));
    expect(rekeyed.paragraphs[0].id).toBe(
      parsedParagraphId(
        'novel_local_attach',
        rekeyed.paragraphs[0].chapterId,
        rekeyed.paragraphs[0].index - 1,
        rekeyed.paragraphs[0].text,
      ),
    );
  });

  it('rekeys import-ready parser output compatibly with full parsed imports', () => {
    const rekeyedParsed = rekeyParsedNovel(parsedNovel(), 'novel_local_attach');
    const rekeyedImport = rekeyParsedNovelImport(parsedNovelImport(), 'novel_local_attach');
    const parsedPages = buildParagraphPages(rekeyedParsed);
    const importPages = Array.from(iterateImportParagraphPageBatches(rekeyedImport, 1)).flat();

    expect(rekeyedImport.novel).toMatchObject({
      id: rekeyedParsed.novel.id,
      lastReadChapterId: rekeyedParsed.novel.lastReadChapterId,
      lastReadParagraphId: undefined,
      rawText: '',
      normalizedText: '',
    });
    expect(rekeyedImport.chapters).toEqual(rekeyedParsed.chapters);
    expect(importPages).toEqual(parsedPages);
    expect(Array.from(iterateImportParagraphPageBatches(rekeyedImport, 1))).toEqual([]);
  });

  it('rekeys and batches async import-ready parser output compatibly with full parsed imports', async () => {
    const rekeyedParsed = rekeyParsedNovel(parsedNovel(), 'novel_local_attach');
    const rekeyedImport = rekeyParsedNovelImport(parsedNovelAsyncImport(), 'novel_local_attach');
    const parsedPages = buildParagraphPages(rekeyedParsed);
    const importBatches: ParagraphPage[][] = [];
    for await (const batch of iterateImportParagraphPageBatchesAsync(rekeyedImport, 1)) {
      importBatches.push(batch);
    }

    expect(importBatches).toHaveLength(2);
    expect(importBatches.flat()).toEqual(parsedPages);
    expect(Array.from(iterateImportParagraphPageBatches(rekeyedImport, 1))).toEqual([]);
  });

  it('keeps rekeyed replacement imports compatible with the existing book id', () => {
    const first = rekeyParsedNovel(parsedNovel(), 'novel_local_attach');
    const secondSource = parsedNovel();
    secondSource.chapters = secondSource.chapters.map((chapter) => ({
      ...chapter,
      title: `${chapter.title} revised`,
    }));
    secondSource.paragraphs = secondSource.paragraphs.map((paragraph) => ({
      ...paragraph,
      text: `${paragraph.text} revised`,
    }));
    const second = rekeyParsedNovel(secondSource, 'novel_local_attach');

    expect(first.novel.id).toBe(second.novel.id);
    expect(first.chapters.map((chapter) => chapter.index)).toEqual(second.chapters.map((chapter) => chapter.index));
    expect(new Set(first.chapters.map((chapter) => chapter.id))).not.toEqual(
      new Set(second.chapters.map((chapter) => chapter.id)),
    );
    expect(new Set(first.paragraphs.map((paragraph) => paragraph.id))).not.toEqual(
      new Set(second.paragraphs.map((paragraph) => paragraph.id)),
    );
  });

  it('isolates rekeyed chapter and paragraph IDs across books', () => {
    const first = rekeyParsedNovel(parsedNovel(), 'novel_a');
    const second = rekeyParsedNovel(parsedNovel(), 'novel_b');

    expect(new Set(first.chapters.map((chapter) => chapter.id))).not.toEqual(
      new Set(second.chapters.map((chapter) => chapter.id)),
    );
    expect(new Set(first.paragraphs.map((paragraph) => paragraph.id))).not.toEqual(
      new Set(second.paragraphs.map((paragraph) => paragraph.id)),
    );
  });

  it('deletes existing server content before replacing a parsed book', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };

    await replaceParsedBookContent(client, 'novel_local_attach');

    expect(calls).toEqual([
      { sql: 'delete from paragraph_search where book_id = $1', params: ['novel_local_attach'] },
      { sql: 'delete from paragraph_pages where book_id = $1', params: ['novel_local_attach'] },
      { sql: 'delete from chapters where book_id = $1', params: ['novel_local_attach'] },
    ]);
  });

  it('applies the upload session chapter split mode during server import', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'noveldesk-import-'));
    const text = [
      '제 1화 시작',
      '',
      '첫 번째 본문입니다. 자동 분리라면 첫 번째 화가 됩니다.',
      '',
      '제 2화 다음',
      '',
      '두 번째 본문입니다. single 모드에서는 같은 장에 남아야 합니다.',
    ].join('\n');
    const uploadDir = path.join(tempDir, 'uploads', 'upload_single');
    await mkdir(uploadDir, { recursive: true });
    const chunkPath = path.join(uploadDir, '00000000.part');
    await writeFile(chunkPath, Buffer.from(text));

    let objectParams: unknown[] | undefined;
    let libraryBookParams: unknown[] | undefined;
    let libraryBookSql: string | undefined;
    let chapterInsertParams: unknown[] | undefined;
    let pageInsertParams: unknown[] | undefined;
    let searchInsertParams: unknown[] | undefined;
    let syncEventParams: unknown[] | undefined;
    let objectDeleteParams: unknown[] | undefined;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('insert into book_objects')) objectParams = params;
        if (sql.includes('insert into library_books')) {
          libraryBookSql = sql;
          libraryBookParams = params;
        }
        if (sql.includes('insert into chapters')) chapterInsertParams = params;
        if (sql.includes('insert into paragraph_pages')) pageInsertParams = params;
        if (sql.includes('insert into paragraph_search')) searchInsertParams = params;
        if (sql.includes('insert into sync_events')) syncEventParams = params;
        if (sql.includes('select storage_key from book_objects')) {
          return { rows: [{ storage_key: 'user_test/sources/old/server-single.txt' }], rowCount: 1 };
        }
        if (sql.includes('insert into object_delete_outbox')) objectDeleteParams = params;
        if (sql.includes("update upload_sessions set status = 'imported'"))
          return { rows: [{ id: 'upload_single' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select * from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_single',
                user_id: 'user_test',
                file_name: 'server-single.txt',
                size_bytes: String(Buffer.byteLength(text)),
                content_type: 'text/plain',
                encoding: 'utf-8',
                chapter_split_mode: 'single',
                total_chunks: 1,
                client_book_id: null,
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return {
            rows: [
              {
                chunk_index: 0,
                size_bytes: Buffer.byteLength(text),
                storage_path: chunkPath,
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => client),
    };

    let uploadDirectoryRemoved: boolean | undefined;
    try {
      await processImportJob(
        pool as unknown as Parameters<typeof processImportJob>[0],
        { ...testConfig(), dataDir: tempDir },
        'job_single',
        'upload_single',
      );
      uploadDirectoryRemoved = await access(uploadDir).then(
        () => false,
        () => true,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(libraryBookParams?.[3]).toBe('txt');
    expect(libraryBookParams?.[11]).toBe(1);
    expect(libraryBookSql).not.toContain('title = excluded.title');
    expect(libraryBookSql).not.toContain('author = excluded.author');
    expect(libraryBookSql).not.toContain('description = excluded.description');
    expect(libraryBookSql).not.toContain('language = excluded.language');
    expect(libraryBookSql).not.toContain('favorite = excluded.favorite');
    expect(libraryBookSql).not.toContain('cover_asset_id = excluded.cover_asset_id');
    expect(libraryBookSql).not.toContain('cover_fit = excluded.cover_fit');
    expect(libraryBookSql).not.toContain('cover_position_x = excluded.cover_position_x');
    expect(libraryBookSql).not.toContain('cover_position_y = excluded.cover_position_y');
    expect(libraryBookSql).toContain("when $19::text = 'append_image_series' then library_books.cover_seed");
    expect(libraryBookSql).toContain("when $19::text = 'append_image_series' then library_books.metadata_revision");
    expect(libraryBookParams?.[18]).toBe('replace_book');
    expect(objectParams?.[0]).toBe(persistentId128('object', [String(objectParams?.[1])]));
    expect(objectParams?.[1]).toBe(integrityHash(Buffer.from(text)));
    expect(client.query).toHaveBeenCalledWith('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      integrityHash(Buffer.from(text)),
    ]);
    expect(objectParams?.[2]).toMatch(
      /^user_test\/sources\/object_[^/]+\/job_single\/[^/]+\/attempt-1\/server-single\.txt$/,
    );
    expect(objectDeleteParams?.[0]).toContain('user_test/sources/old/server-single.txt');
    expect(libraryBookParams?.[10]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chapterInsertParams).toBeDefined();
    expect(chapterInsertParams).toHaveLength(15);
    expect(chapterInsertParams?.[3]).toBe('server-single');
    expect(chapterInsertParams?.[4]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pageInsertParams?.[0]).toBe(
      paragraphPageId(String(pageInsertParams?.[1]), String(pageInsertParams?.[2]), Number(pageInsertParams?.[3])),
    );
    expect(pageInsertParams?.[7]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(searchInsertParams?.[0]).toBe(
      persistentId128('paragraph_search', [
        String(searchInsertParams?.[2]),
        String(searchInsertParams?.[3]),
        String(searchInsertParams?.[1]),
      ]),
    );
    expect(syncEventParams?.[0]).toBe(
      persistentId128('sync_event', [
        'user_test',
        'book_imported',
        String(syncEventParams?.[3]),
        String(syncEventParams?.[7]),
      ]),
    );
    expect(JSON.parse(String(syncEventParams?.[6])).payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.query).toHaveBeenCalledWith('delete from upload_chunks where upload_id = $1', ['upload_single']);
    expect(uploadDirectoryRemoved).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('persists fixed-document section identity and section count during server import', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-import-series-'));
    const bytes = await twoReleaseSeriesComicArchive();
    const uploadDir = path.join(tempDir, 'uploads', 'upload_series');
    const chunkPath = path.join(uploadDir, '00000000.part');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(chunkPath, bytes);

    let libraryBookSql: string | undefined;
    let libraryBookParams: unknown[] | undefined;
    let chapterInsertSql: string | undefined;
    let chapterInsertParams: unknown[] | undefined;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 1 };
        if (sql.includes('insert into library_books')) {
          libraryBookSql = sql;
          libraryBookParams = params;
        }
        if (sql.includes('insert into chapters')) {
          chapterInsertSql = sql;
          chapterInsertParams = params;
        }
        if (sql.includes("update upload_sessions set status = 'imported'")) {
          return { rows: [{ id: 'upload_series' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select * from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_series',
                user_id: 'user_test',
                file_name: 'series.cbz',
                size_bytes: String(bytes.length),
                content_type: 'application/vnd.comicbook+zip',
                encoding: 'auto',
                total_chunks: 1,
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return { rows: [{ chunk_index: 0, size_bytes: bytes.length, storage_path: chunkPath }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => client),
    };

    try {
      await processImportJob(
        pool as unknown as Parameters<typeof processImportJob>[0],
        { ...testConfig(), dataDir: tempDir },
        'job_series',
        'upload_series',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(libraryBookSql).toContain('document_section_count');
    expect(libraryBookSql).toContain('document_section_count = excluded.document_section_count');
    expect(libraryBookParams?.[15]).toBe(2);
    expect(chapterInsertSql).toContain(
      'document_section_id, document_section_title,\n        document_section_index, document_page_index_in_section',
    );
    expect(chapterInsertSql).toContain('document_section_id = excluded.document_section_id');
    expect(chapterInsertSql).toContain('document_section_title = excluded.document_section_title');
    expect(chapterInsertSql).toContain('document_section_index = excluded.document_section_index');
    expect(chapterInsertSql).toContain('document_page_index_in_section = excluded.document_page_index_in_section');
    expect(chapterInsertParams).toHaveLength(30);
    expect(chapterInsertParams?.slice(9, 13)).toEqual(['chapter:101', '1화', 1, 1]);
    expect(chapterInsertParams?.slice(24, 28)).toEqual(['chapter:102', '2화', 2, 1]);
  });

  it('finishes a repeated image-series delta as a no-op without rewriting the aggregate or cover', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-import-series-noop-'));
    const base = await seriesComicArchive([{ remoteId: 'chapter:101', title: '1화', sourceContentHash: 'hash-1' }]);
    const delta = await seriesComicArchive([
      { remoteId: 'chapter:101', title: '무시할 중복 1화', sourceContentHash: 'sha256:HASH-1' },
    ]);
    const uploadDir = path.join(tempDir, 'uploads', 'upload_series_noop');
    const chunkPath = path.join(uploadDir, '00000000.part');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(chunkPath, delta);
    vi.mocked(getObjectBuffer).mockResolvedValueOnce({
      body: base,
      contentType: 'application/vnd.comicbook+zip',
      contentLength: base.length,
    });
    vi.mocked(putRawBookObject).mockClear();

    const appendClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select pg_advisory_lock') || sql.includes('select pg_advisory_unlock')) {
          return { rows: [{ locked: true }], rowCount: 1 };
        }
        if (sql.includes('join book_objects object')) {
          return {
            rows: [
              {
                id: 'book_series_1',
                format: 'image_archive',
                active_content_revision_id: 'content_revision_7',
                source_file_name: '연재 작품.cbz',
                storage_key: 'user_test/sources/series.cbz',
                content_type: 'application/vnd.comicbook+zip',
                total_chapters: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 1 };
        if (sql.includes('select active_content_revision_id from library_books')) {
          return { rows: [{ active_content_revision_id: 'content_revision_7' }], rowCount: 1 };
        }
        if (sql.includes("update upload_sessions set status = 'imported'")) {
          return { rows: [{ id: 'upload_series_noop' }], rowCount: 1 };
        }
        if (sql.startsWith('delete from upload_chunks')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('update import_jobs')) return { rows: [{ id: 'job_series_noop' }], rowCount: 1 };
        throw new Error(`unexpected append query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select * from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_series_noop',
                user_id: 'user_test',
                file_name: 'delta.cbz',
                size_bytes: String(delta.length),
                content_type: 'application/vnd.comicbook+zip',
                encoding: 'auto',
                total_chunks: 1,
                client_book_id: 'book_series_1',
                source_content_hash: integrityHash(delta),
                import_mode: 'append_image_series',
                base_active_content_revision_id: 'content_revision_7',
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return { rows: [{ chunk_index: 0, size_bytes: delta.length, storage_path: chunkPath }] };
        }
        if (sql.startsWith('update import_jobs')) return { rows: [{ id: 'job_series_noop' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => appendClient),
    };

    let uploadDirectoryRemoved: boolean | undefined;
    try {
      await processImportJob(
        pool as unknown as Parameters<typeof processImportJob>[0],
        { ...testConfig(), dataDir: tempDir },
        'job_series_noop',
        'upload_series_noop',
      );
      uploadDirectoryRemoved = await access(uploadDir).then(
        () => false,
        () => true,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(getObjectBuffer).toHaveBeenCalledTimes(1);
    expect(putRawBookObject).not.toHaveBeenCalled();
    expect(appendClient.query).not.toHaveBeenCalledWith(expect.stringContaining('delete from book_assets'));
    expect(appendClient.query).toHaveBeenCalledWith('delete from upload_chunks where upload_id = $1', [
      'upload_series_noop',
    ]);
    expect(uploadDirectoryRemoved).toBe(true);
    expect(appendClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale image-series delta that would replace an existing chapter', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-import-series-stale-replacement-'));
    const base = await seriesComicArchive([
      { remoteId: 'chapter:101', title: '1화 최신', sourceContentHash: 'hash-new' },
    ]);
    const delta = await seriesComicArchive([
      { remoteId: 'chapter:101', title: '1화 이전', sourceContentHash: 'hash-old' },
    ]);
    const uploadDir = path.join(tempDir, 'uploads', 'upload_series_stale_replacement');
    const chunkPath = path.join(uploadDir, '00000000.part');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(chunkPath, delta);
    vi.mocked(getObjectBuffer).mockClear();
    vi.mocked(getObjectBuffer).mockResolvedValueOnce({
      body: base,
      contentType: 'application/vnd.comicbook+zip',
      contentLength: base.length,
    });
    vi.mocked(putRawBookObject).mockClear();

    const appendClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select pg_advisory_lock') || sql.includes('select pg_advisory_unlock')) {
          return { rows: [{ locked: true }], rowCount: 1 };
        }
        if (sql.includes('join book_objects object')) {
          return {
            rows: [
              {
                id: 'book_series_1',
                format: 'image_archive',
                active_content_revision_id: 'content_revision_7',
                source_file_name: '연재 작품.cbz',
                storage_key: 'user_test/sources/series.cbz',
                content_type: 'application/vnd.comicbook+zip',
                total_chapters: 1,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select * from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_series_stale_replacement',
                user_id: 'user_test',
                file_name: 'delta.cbz',
                size_bytes: String(delta.length),
                content_type: 'application/vnd.comicbook+zip',
                encoding: 'auto',
                total_chunks: 1,
                client_book_id: 'book_series_1',
                source_content_hash: integrityHash(delta),
                import_mode: 'append_image_series',
                base_active_content_revision_id: 'content_revision_6',
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return { rows: [{ chunk_index: 0, size_bytes: delta.length, storage_path: chunkPath }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => appendClient),
    };

    try {
      await expect(
        processImportJob(
          pool as unknown as Parameters<typeof processImportJob>[0],
          { ...testConfig(), dataDir: tempDir },
          'job_series_stale_replacement',
          'upload_series_stale_replacement',
        ),
      ).rejects.toThrow('image_series_append_base_changed');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(getObjectBuffer).toHaveBeenCalledTimes(1);
    expect(putRawBookObject).not.toHaveBeenCalled();
    expect(appendClient.release).toHaveBeenCalledTimes(1);
  });

  it('merges and activates a changed image-series delta without replacing the existing cover or metadata', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-import-series-append-'));
    const base = await seriesComicArchive([{ remoteId: 'chapter:101', title: '1화', sourceContentHash: 'hash-1' }]);
    const delta = await seriesComicArchive([
      { remoteId: 'chapter:101', title: '1화 수정', sourceContentHash: 'hash-1-revised' },
      { remoteId: 'chapter:102', title: '2화', sourceContentHash: 'hash-2' },
    ]);
    const uploadDir = path.join(tempDir, 'uploads', 'upload_series_append');
    const chunkPath = path.join(uploadDir, '00000000.part');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(chunkPath, delta);
    vi.mocked(getObjectBuffer).mockResolvedValueOnce({
      body: base,
      contentType: 'application/vnd.comicbook+zip',
      contentLength: base.length,
    });
    vi.mocked(putRawBookObject).mockClear();

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let libraryBookSql: string | undefined;
    let libraryBookParams: unknown[] | undefined;
    let chapterInsertParams: unknown[] | undefined;
    const insertedAssetKinds: string[] = [];
    const appendClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select pg_advisory_lock') || sql.includes('select pg_advisory_unlock')) {
          return { rows: [{ locked: true }], rowCount: 1 };
        }
        if (sql.includes('join book_objects object')) {
          return {
            rows: [
              {
                id: 'book_series_1',
                format: 'image_archive',
                active_content_revision_id: 'content_revision_7',
                source_file_name: '연재 작품.cbz',
                storage_key: 'user_test/sources/series.cbz',
                content_type: 'application/vnd.comicbook+zip',
                total_chapters: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('normalized_text_hash, active_content_revision_id')) {
          return {
            rows: [
              {
                id: 'book_series_1',
                user_id: 'user_test',
                normalized_text_hash: 'old-normalized-hash',
                active_content_revision_id: 'content_revision_7',
                content_revision_number: 7,
                active_character_graph_revision_id: null,
                revision_fence: 11,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('select id from library_books') && sql.includes('active_content_revision_id = $3')) {
          return { rows: [{ id: 'book_series_1' }], rowCount: 1 };
        }
        if (sql === 'select storage_key from book_objects where raw_text_hash = $1 for update') {
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'select object_id from library_books where id = $1 and user_id = $2') {
          return { rows: [{ object_id: 'object_old_series' }], rowCount: 1 };
        }
        if (sql.includes('delete from book_objects object')) {
          return { rows: [{ storage_key: 'user_test/sources/series.cbz' }], rowCount: 1 };
        }
        if (sql.includes('asset.provenance')) {
          return { rows: [{ id: 'cover_existing', provenance: 'archive_embedded' }], rowCount: 1 };
        }
        if (sql.includes("kind in ('epub_resource', 'document_page')")) {
          return { rows: [{ storage_key: 'user_test/book_series_1/old/001.png' }], rowCount: 1 };
        }
        if (sql === 'select id, storage_key from book_assets where id = any($1::text[])') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("status = 'superseded' and kind <> 'cover'")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('insert into library_books')) {
          libraryBookSql = sql;
          libraryBookParams = params;
        }
        if (sql.includes('insert into book_assets')) insertedAssetKinds.push(String(params?.[3]));
        if (sql.includes('insert into chapters')) chapterInsertParams = params;
        if (sql.includes('insert into reading_positions')) return { rows: [], rowCount: 1 };
        if (sql.includes('select coalesce(max(revision_number)')) {
          return { rows: [{ revision_number: 3 }], rowCount: 1 };
        }
        if (sql.includes('select id, book_id, canonical_name, aliases')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('from character_relations') && sql.includes('order by id asc')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('set active_content_revision_id = $4')) {
          return { rows: [{ id: 'book_series_1' }], rowCount: 1 };
        }
        if (sql.includes("update upload_sessions set status = 'imported'")) {
          return { rows: [{ id: 'upload_series_append' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select * from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_series_append',
                user_id: 'user_test',
                file_name: 'delta.cbz',
                size_bytes: String(delta.length),
                content_type: 'application/vnd.comicbook+zip',
                encoding: 'auto',
                total_chunks: 1,
                client_book_id: 'book_series_1',
                source_content_hash: integrityHash(delta),
                import_mode: 'append_image_series',
                base_active_content_revision_id: 'content_revision_7',
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return { rows: [{ chunk_index: 0, size_bytes: delta.length, storage_path: chunkPath }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => appendClient),
    };

    let uploadDirectoryRemoved: boolean | undefined;
    try {
      await processImportJob(
        pool as unknown as Parameters<typeof processImportJob>[0],
        { ...testConfig(), dataDir: tempDir },
        'job_series_append',
        'upload_series_append',
      );
      uploadDirectoryRemoved = await access(uploadDir).then(
        () => false,
        () => true,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const storedSource = vi.mocked(putRawBookObject).mock.calls.find((call) => String(call[2]).includes('/sources/'));
    expect(storedSource).toBeDefined();
    const mergedManifest = await readSeriesImageArchiveManifest(
      new Blob([new Uint8Array(storedSource?.[3] ?? Buffer.alloc(0))], {
        type: String(storedSource?.[4] ?? ''),
      }),
    );
    expect(mergedManifest?.chapters.map((chapter) => [chapter.remoteId, chapter.title])).toEqual([
      ['chapter:101', '1화 수정'],
      ['chapter:102', '2화'],
    ]);
    expect(libraryBookSql).toContain("when $19::text = 'append_image_series' then library_books.cover_seed");
    expect(libraryBookSql).toContain("when $19::text = 'append_image_series' then library_books.metadata_revision");
    expect(libraryBookParams?.[18]).toBe('append_image_series');
    expect(libraryBookParams?.[11]).toBe(2);
    expect(chapterInsertParams).toHaveLength(30);
    expect(chapterInsertParams?.slice(9, 13)).toEqual(['chapter:101', '1화 수정', 1, 1]);
    expect(chapterInsertParams?.slice(24, 28)).toEqual(['chapter:102', '2화', 2, 1]);
    expect(insertedAssetKinds).toEqual(['document_page', 'document_page']);
    expect(queries.some(({ sql }) => sql.includes("kind = 'cover' and status = 'active'"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes('set cover_asset_id = $1'))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes('insert into reading_positions'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("set status = 'superseded', superseded_at = now()"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("set status = 'active', activated_at = now()"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('set active_content_revision_id = $4'))).toBe(true);
    const replacedKeys = queries
      .filter(
        ({ sql, params }) =>
          sql.includes('insert into object_delete_outbox') && params?.[1] === 'replaced_import_object',
      )
      .flatMap(({ params }) => (Array.isArray(params?.[0]) ? params[0] : []));
    expect(replacedKeys).toEqual(
      expect.arrayContaining([
        'user_test/sources/series.cbz',
        'user_test/book_series_1/old/001.png',
        expect.stringMatching(/\/staged\/job_series_append\/legacy\/attempt-1\/[^/]+\/.+\/00001\.png$/),
      ]),
    );
    expect(uploadDirectoryRemoved).toBe(true);
    expect(appendClient.release).toHaveBeenCalledTimes(1);
  });

  it('rebases a stale new-chapter delta and activates its archive cover when no active cover exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-import-series-stale-add-'));
    const base = await seriesComicArchive([{ remoteId: 'chapter:101', title: '1화', sourceContentHash: 'hash-1' }]);
    const delta = await seriesComicArchive([{ remoteId: 'chapter:102', title: '2화', sourceContentHash: 'hash-2' }]);
    const uploadDir = path.join(tempDir, 'uploads', 'upload_series_stale_add');
    const chunkPath = path.join(uploadDir, '00000000.part');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(chunkPath, delta);
    vi.mocked(getObjectBuffer).mockResolvedValueOnce({
      body: base,
      contentType: 'application/vnd.comicbook+zip',
      contentLength: base.length,
    });
    vi.mocked(putRawBookObject).mockClear();

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const insertedAssetKinds: string[] = [];
    const appendClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select pg_advisory_lock') || sql.includes('select pg_advisory_unlock')) {
          return { rows: [{ locked: true }], rowCount: 1 };
        }
        if (sql.includes('join book_objects object')) {
          return {
            rows: [
              {
                id: 'book_series_1',
                format: 'image_archive',
                active_content_revision_id: 'content_revision_7',
                source_file_name: '연재 작품.cbz',
                storage_key: 'user_test/sources/series.cbz',
                content_type: 'application/vnd.comicbook+zip',
                total_chapters: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('normalized_text_hash, active_content_revision_id')) {
          return {
            rows: [
              {
                id: 'book_series_1',
                user_id: 'user_test',
                normalized_text_hash: 'old-normalized-hash',
                active_content_revision_id: 'content_revision_7',
                content_revision_number: 7,
                active_character_graph_revision_id: null,
                revision_fence: 11,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('select id from library_books') && sql.includes('active_content_revision_id = $3')) {
          return { rows: [{ id: 'book_series_1' }], rowCount: 1 };
        }
        if (sql === 'select storage_key from book_objects where raw_text_hash = $1 for update') {
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'select object_id from library_books where id = $1 and user_id = $2') {
          return { rows: [{ object_id: 'object_old_series' }], rowCount: 1 };
        }
        if (sql.includes('delete from book_objects object')) {
          return { rows: [{ storage_key: 'user_test/sources/series.cbz' }], rowCount: 1 };
        }
        if (sql.includes('asset.provenance')) {
          return { rows: [{ id: null, provenance: null }], rowCount: 1 };
        }
        if (sql.includes("kind in ('epub_resource', 'document_page')")) {
          return { rows: [{ storage_key: 'user_test/book_series_1/old/001.png' }], rowCount: 1 };
        }
        if (sql === 'select id, storage_key from book_assets where id = any($1::text[])') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("status = 'superseded' and kind <> 'cover'")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('insert into book_assets')) insertedAssetKinds.push(String(params?.[3]));
        if (sql.includes('insert into reading_positions')) return { rows: [], rowCount: 1 };
        if (sql.includes('select coalesce(max(revision_number)')) {
          return { rows: [{ revision_number: 3 }], rowCount: 1 };
        }
        if (sql.includes('select id, book_id, canonical_name, aliases')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('from character_relations') && sql.includes('order by id asc')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('set active_content_revision_id = $4')) {
          return { rows: [{ id: 'book_series_1' }], rowCount: 1 };
        }
        if (sql.includes("update upload_sessions set status = 'imported'")) {
          return { rows: [{ id: 'upload_series_stale_add' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select * from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_series_stale_add',
                user_id: 'user_test',
                file_name: 'delta.cbz',
                size_bytes: String(delta.length),
                content_type: 'application/vnd.comicbook+zip',
                encoding: 'auto',
                total_chunks: 1,
                client_book_id: 'book_series_1',
                source_content_hash: integrityHash(delta),
                import_mode: 'append_image_series',
                base_active_content_revision_id: 'content_revision_6',
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return { rows: [{ chunk_index: 0, size_bytes: delta.length, storage_path: chunkPath }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => appendClient),
    };

    let uploadDirectoryRemoved: boolean | undefined;
    try {
      await processImportJob(
        pool as unknown as Parameters<typeof processImportJob>[0],
        { ...testConfig(), dataDir: tempDir },
        'job_series_stale_add',
        'upload_series_stale_add',
      );
      uploadDirectoryRemoved = await access(uploadDir).then(
        () => false,
        () => true,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const storedSource = vi.mocked(putRawBookObject).mock.calls.find((call) => String(call[2]).includes('/sources/'));
    expect(storedSource).toBeDefined();
    const mergedManifest = await readSeriesImageArchiveManifest(
      new Blob([new Uint8Array(storedSource?.[3] ?? Buffer.alloc(0))], {
        type: String(storedSource?.[4] ?? ''),
      }),
    );
    expect(mergedManifest?.chapters.map((chapter) => chapter.remoteId)).toEqual(['chapter:101', 'chapter:102']);
    expect(
      queries.some(
        ({ sql, params }) =>
          sql.includes('select id from library_books') &&
          sql.includes('active_content_revision_id = $3') &&
          params?.[2] === 'content_revision_7',
      ),
    ).toBe(true);
    expect(insertedAssetKinds).toEqual(expect.arrayContaining(['cover', 'document_page']));
    expect(queries.some(({ sql }) => sql.includes('set cover_asset_id = $1'))).toBe(true);
    expect(uploadDirectoryRemoved).toBe(true);
    expect(appendClient.release).toHaveBeenCalledTimes(1);
  });

  it('keeps an import queued while BullMQ still has retry attempts remaining', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select * from upload_sessions')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Parameters<typeof processImportJob>[0];

    await expect(
      processImportJob(pool, testConfig(), 'job_retrying', 'upload_missing', {
        attemptNumber: 1,
        maxAttempts: 3,
        finalAttempt: false,
      }),
    ).rejects.toThrow('Upload session not found');

    const retryProgress = queries.find(
      ({ sql, params }) => sql.includes('update import_jobs') && params?.includes('queued'),
    );
    expect(retryProgress?.params).toEqual(
      expect.arrayContaining(['queued', '서버 가져오기를 재시도합니다. (1/3 실패)', 'job_retrying']),
    );
    expect(queries.some(({ sql }) => sql.includes("update upload_sessions set status = 'failed'"))).toBe(false);
  });

  it.each(['user_supplied', 'approved_enrichment'] as const)(
    'keeps an existing %s cover while scheduling the incoming archive cover for durable cleanup',
    async (coverProvenance) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-import-cover-'));
      const bytes = await singlePageComicArchive();
      const uploadDir = path.join(tempDir, 'uploads', 'upload_cover');
      const chunkPath = path.join(uploadDir, '00000000.part');
      await mkdir(uploadDir, { recursive: true });
      await writeFile(chunkPath, bytes);
      const lifecycleQueries: Array<{ sql: string; params?: unknown[] }> = [];
      const insertedAssetKinds: string[] = [];
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          lifecycleQueries.push({ sql, params });
          if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 1 };
          if (sql.includes('asset.provenance')) {
            return { rows: [{ id: 'cover_existing', provenance: coverProvenance }], rowCount: 1 };
          }
          if (sql.includes('insert into book_assets')) insertedAssetKinds.push(String(params?.[3]));
          if (sql.includes("update upload_sessions set status = 'imported'")) {
            return { rows: [{ id: 'upload_cover' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
      };
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('select * from upload_sessions')) {
            return {
              rows: [
                {
                  id: 'upload_cover',
                  user_id: 'user_test',
                  file_name: 'comic.cbz',
                  size_bytes: String(bytes.length),
                  content_type: 'application/zip',
                  encoding: 'auto',
                  total_chunks: 1,
                },
              ],
            };
          }
          if (sql.includes('from upload_chunks')) {
            return { rows: [{ chunk_index: 0, size_bytes: bytes.length, storage_path: chunkPath }] };
          }
          return { rows: [], rowCount: 1 };
        }),
        connect: vi.fn(async () => client),
      };
      try {
        await processImportJob(
          pool as unknown as Parameters<typeof processImportJob>[0],
          { ...testConfig(), dataDir: tempDir },
          'job_cover',
          'upload_cover',
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }

      expect(insertedAssetKinds).toEqual(['document_page']);
      expect(lifecycleQueries.find(({ sql }) => sql.includes("status = 'superseded'"))?.sql).toContain(
        "kind <> 'cover'",
      );
      const releaseIndex = lifecycleQueries.findIndex(({ sql }) => sql.startsWith('delete from object_delete_outbox'));
      const cleanupIndex = lifecycleQueries.findIndex(({ sql }) => sql.includes('insert into object_delete_outbox'));
      expect(releaseIndex).toBeGreaterThanOrEqual(0);
      expect(cleanupIndex).toBeGreaterThan(releaseIndex);
      expect(lifecycleQueries[cleanupIndex]?.params?.[0]).toEqual([
        expect.stringMatching(/\/staged\/job_cover\/legacy\/attempt-1\/[^/]+\/001\.png$/),
      ]);
    },
  );

  it('ignores a retained BullMQ delivery after its execution fence was superseded', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        expect(sql).toContain("status = 'queued'");
        expect(sql).toContain('active_queue_job_id = $2');
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Parameters<typeof processImportJob>[0];

    await expect(
      processImportJob(pool, testConfig(), 'job_old', 'upload_old', {
        attemptNumber: 1,
        maxAttempts: 3,
        finalAttempt: false,
        executionId: 'import_attempt_old',
      }),
    ).resolves.toBeUndefined();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('marks the upload session failed only after the final BullMQ attempt', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select * from upload_sessions')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Parameters<typeof processImportJob>[0];

    await expect(
      processImportJob(pool, testConfig(), 'job_failed', 'upload_missing', {
        attemptNumber: 3,
        maxAttempts: 3,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Upload session not found');

    expect(queries).toContainEqual({
      sql: "update upload_sessions set status = 'failed', updated_at = now() where id = $1 and status not in ('imported', 'cancelled')",
      params: ['upload_missing'],
    });
    const failedProgress = queries.find(
      ({ sql, params }) => sql.includes('update import_jobs') && params?.includes('failed'),
    );
    expect(failedProgress?.params).toEqual(
      expect.arrayContaining(['failed', '서버 가져오기에 실패했습니다.', 'job_failed']),
    );
  });
});

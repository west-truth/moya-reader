import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../domain/hash';
import { integrityHash } from '../domain/id-hash-contract';
import { decodeNovelTextWithEncoding, parseNovelFileForImport } from '../domain/parser';
import type { Paragraph, ParsedNovelImportChapterSource } from '../domain/types';
import { runBrowserImportPipeline } from '../services/import/browser-import-pipeline';
import {
  parseDecodedNovelTextForImportCooperatively,
  type CooperativeImportParseProgress,
} from '../services/import/cooperative-import-parser';
import type { ImportProgress } from '../services/import/import-service';
import { hashTextRangeCooperatively } from '../services/import/cooperative-text-hash';
import { getNovels, listSyncOutbox, openReaderDb, resetReaderDbForTests } from '../storage/db';
import { exportBookSource } from '../storage/book-asset-store';

const IMPORT_STATUS_ORDER: ImportProgress['status'][] = [
  'queued',
  'reading',
  'decoding',
  'splitting_chapters',
  'writing',
  'cancelling',
  'ready',
  'failed',
];

const PARSE_PHASE_ORDER: CooperativeImportParseProgress['phase'][] = [
  'normalizing_text',
  'hashing_normalized_text',
  'detecting_chapters',
  'building_chapters',
];

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function collectParagraphs(source: ParsedNovelImportChapterSource): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  for await (const item of source) paragraphs.push(...item.paragraphs);
  return paragraphs;
}

function withoutTimestamps<T extends { createdAt: string; updatedAt: string }>(
  value: T,
): Omit<T, 'createdAt' | 'updatedAt'> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value;
  return rest;
}

function chapterFixture(chapterCount: number, paragraphsPerChapter: number): string {
  return Array.from({ length: chapterCount }, (_, chapterIndex) => {
    const chapter = chapterIndex + 1;
    const paragraphs = Array.from(
      { length: paragraphsPerChapter },
      (_, paragraphIndex) => `제 ${chapter}화의 ${paragraphIndex + 1}번째 본문 문단입니다.`,
    );
    return `제 ${chapter}화 테스트 장\n\n${paragraphs.join('\n\n')}`;
  }).join('\n\n');
}

async function revisionStoreCounts(): Promise<Record<string, number>> {
  const storeNames = [
    'book_content_revisions',
    'book_content_chapters',
    'book_content_paragraphs',
    'book_content_paragraph_pages',
    'book_content_paragraph_search',
  ];
  const db = await openReaderDb();
  const tx = db.transaction(storeNames, 'readonly');
  const entries = await Promise.all(
    storeNames.map(
      (storeName) =>
        new Promise<[string, number]>((resolve, reject) => {
          const request = tx.objectStore(storeName).count();
          request.onsuccess = () => resolve([storeName, request.result]);
          request.onerror = () => reject(request.error);
        }),
    ),
  );
  return Object.fromEntries(entries);
}

function expectMonotonicWorkerProgress(events: ImportProgress[]): void {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    expect(IMPORT_STATUS_ORDER.indexOf(current.status)).toBeGreaterThanOrEqual(
      IMPORT_STATUS_ORDER.indexOf(previous.status),
    );
    expect(current.bytesRead).toBeGreaterThanOrEqual(previous.bytesRead);
    expect(current.chaptersDetected).toBeGreaterThanOrEqual(previous.chaptersDetected);
    expect(current.paragraphsWritten).toBeGreaterThanOrEqual(previous.paragraphsWritten);
  }
}

describe('browser import worker pipeline', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('keeps incremental text hashes identical across surrogate-pair chunk boundaries', async () => {
    const source = `prefix-${'가'.repeat(8)}😀-${'나'.repeat(9)}-suffix`;
    expect(await hashTextRangeCooperatively(source, 0, source.length, { chunkCharacters: 16 })).toBe(
      integrityHash(source),
    );
    expect(await hashTextRangeCooperatively(source, 0, source.length, { chunkCharacters: 1 })).toBe(
      integrityHash(source),
    );
  });

  it('emits monotonic phase progress through persisted completion', async () => {
    const source = chapterFixture(24, 4);
    const buffer = toBuffer(source);
    const sourceBlob = new Blob([source], { type: 'text/plain' });
    const progress: ImportProgress[] = [];

    const result = await runBrowserImportPipeline({
      jobId: 'progress-job',
      fileName: 'progress.txt',
      buffer,
      sourceBlob,
      totalBytes: buffer.byteLength,
      encoding: 'utf-8',
      chapterSplitMode: 'mixed',
      onProgress: (next) => progress.push(next),
      yieldControl: async () => undefined,
    });

    expectMonotonicWorkerProgress(progress);
    expect(progress.map((event) => event.subphase)).toEqual(
      expect.arrayContaining([
        'hashing_source',
        'decoding_text',
        'normalizing_text',
        'hashing_normalized_text',
        'detecting_chapters',
        'building_chapters',
        'staging_chapters',
        'writing_pages',
        'activating_revision',
        'complete',
      ]),
    );
    expect(progress.at(-1)).toMatchObject({
      status: 'ready',
      subphase: 'complete',
      chaptersDetected: result.novel.totalChapters,
      paragraphsWritten: result.novel.totalParagraphs,
    });
    expect(await getNovels()).toHaveLength(1);
    const exported = await exportBookSource(result.novel.id);
    expect(exported?.metadata).toMatchObject({
      provenance: 'original',
      fileName: 'progress.txt',
      byteLength: sourceBlob.size,
      contentHash: result.novel.rawTextHash,
    });
    expect(`sha256:${await sha256((await exported!.blob.arrayBuffer()) as ArrayBuffer)}`).toBe(
      result.novel.rawTextHash,
    );
  });

  it('keeps the modeled exact-fixture parse cadence below ten seconds', async () => {
    const source = chapterFixture(1_025, 2);
    const buffer = toBuffer(source);
    const rawTextHash = await sha256(buffer);
    const decoded = decodeNovelTextWithEncoding(buffer, 'utf-8');
    const timeline: Array<{ at: number; progress: CooperativeImportParseProgress }> = [];
    let currentProgress: CooperativeImportParseProgress | undefined;
    let modeledNow = 0;

    await parseDecodedNovelTextForImportCooperatively('phase6-modeled.txt', decoded, rawTextHash, {
      chapterSplitMode: 'mixed',
      onProgress: (progress) => {
        currentProgress = progress;
        timeline.push({ at: modeledNow, progress });
      },
      yieldControl: async () => {
        if (!currentProgress) return;
        modeledNow +=
          currentProgress.phase === 'detecting_chapters'
            ? 9_000
            : currentProgress.phase === 'building_chapters' && currentProgress.chaptersProcessed === 0
              ? 8_000
              : 4_000;
      },
    });
    const terminalAt = modeledNow;

    for (let index = 1; index < timeline.length; index += 1) {
      const previous = timeline[index - 1];
      const current = timeline[index];
      expect(PARSE_PHASE_ORDER.indexOf(current.progress.phase)).toBeGreaterThanOrEqual(
        PARSE_PHASE_ORDER.indexOf(previous.progress.phase),
      );
      expect(current.progress.chaptersProcessed).toBeGreaterThanOrEqual(previous.progress.chaptersProcessed);
      expect(current.progress.totalParagraphs).toBeGreaterThanOrEqual(previous.progress.totalParagraphs);
    }

    const timestamps = [0, ...timeline.map((event) => event.at), terminalAt];
    const maximumModeledGap = Math.max(...timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]));
    expect(maximumModeledGap).toBeLessThanOrEqual(10_000);
    expect(maximumModeledGap).toBeLessThan(15_000);
    expect(timeline.filter((event) => event.progress.phase === 'building_chapters').at(-1)?.progress).toMatchObject({
      chaptersProcessed: 1_025,
      totalChapters: 1_025,
    });
  });

  it('yields and accepts cancellation inside one large chapter', async () => {
    const source = `1화\n\n${'긴 단일 화의 본문 문단입니다.\n'.repeat(60_000)}`;
    const buffer = toBuffer(source);
    let cancelled = false;
    let inChapterCheckpoints = 0;

    await expect(
      parseDecodedNovelTextForImportCooperatively(
        'single-large-chapter.txt',
        decodeNovelTextWithEncoding(buffer, 'utf-8'),
        await sha256(buffer),
        {
          chapterSplitMode: 'single',
          shouldCancel: () => cancelled,
          onProgress: (progress) => {
            if (progress.phase === 'building_chapters' && progress.chaptersProcessed === 0) {
              inChapterCheckpoints += 1;
              if (inChapterCheckpoints >= 2) cancelled = true;
            }
          },
          yieldControl: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(inChapterCheckpoints).toBeGreaterThanOrEqual(2);
  });

  it('preserves canonical parser source, identity, and hash output', async () => {
    const source =
      '\uFEFF머리말\r\n\r\n제 1화 시작\r\n\r\n첫 문단\t내용  \r\n\r\n[002]\r\n\r\n둘째 장 본문입니다. '.repeat(4) +
      '\r\n\r\n제 3화 끝\r\n\r\n마지막 문단';
    const fileName = 'parity-progress.txt';
    const canonicalBuffer = toBuffer(source);
    const cooperativeBuffer = canonicalBuffer.slice(0);
    const canonical = await parseNovelFileForImport(fileName, canonicalBuffer, 'utf-8', {
      chapterSplitMode: 'mixed',
    });
    const cooperative = await parseDecodedNovelTextForImportCooperatively(
      fileName,
      decodeNovelTextWithEncoding(cooperativeBuffer, 'utf-8'),
      await sha256(cooperativeBuffer),
      {
        chapterSplitMode: 'mixed',
        yieldControl: async () => undefined,
      },
    );

    const canonicalParagraphs = await collectParagraphs(canonical.consumeChapterParagraphs());
    const cooperativeParagraphs = await collectParagraphs(cooperative.consumeChapterParagraphs());

    expect(withoutTimestamps(cooperative.novel)).toEqual(withoutTimestamps(canonical.novel));
    expect(cooperative.chapters.map(withoutTimestamps)).toEqual(canonical.chapters.map(withoutTimestamps));
    expect(cooperativeParagraphs).toEqual(canonicalParagraphs);
  });

  it('removes every staged revision row when cancellation interrupts page writes', async () => {
    const source = chapterFixture(1, 600);
    const buffer = toBuffer(source);
    let cancelled = false;

    await expect(
      runBrowserImportPipeline({
        jobId: 'cancel-job',
        fileName: 'cancelled-import.txt',
        buffer,
        totalBytes: buffer.byteLength,
        encoding: 'utf-8',
        chapterSplitMode: 'single',
        shouldCancel: () => cancelled,
        onProgress: (progress) => {
          if (progress.status === 'writing' && progress.paragraphsWritten > 0) cancelled = true;
        },
        yieldControl: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(await getNovels()).toEqual([]);
    expect(await revisionStoreCounts()).toEqual({
      book_content_revisions: 0,
      book_content_chapters: 0,
      book_content_paragraphs: 0,
      book_content_paragraph_pages: 0,
      book_content_paragraph_search: 0,
    });
    expect(await listSyncOutbox()).toEqual([]);
  });

  it('aborts and removes staged rows when cancellation starts before revision activation', async () => {
    const source = chapterFixture(4, 20);
    const buffer = toBuffer(source);
    let cancelled = false;

    await expect(
      runBrowserImportPipeline({
        jobId: 'activation-cancel-job',
        fileName: 'activation-cancelled-import.txt',
        buffer,
        totalBytes: buffer.byteLength,
        encoding: 'utf-8',
        chapterSplitMode: 'mixed',
        shouldCancel: () => cancelled,
        onProgress: (progress) => {
          if (progress.subphase === 'activating_revision') cancelled = true;
        },
        yieldControl: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(await getNovels()).toEqual([]);
    expect(await revisionStoreCounts()).toEqual({
      book_content_revisions: 0,
      book_content_chapters: 0,
      book_content_paragraphs: 0,
      book_content_paragraph_pages: 0,
      book_content_paragraph_search: 0,
    });
    expect(await listSyncOutbox()).toEqual([]);
  });
});

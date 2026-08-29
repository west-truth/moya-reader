import {
  BlobReader,
  BlobWriter,
  TextWriter,
  Uint8ArrayReader,
  ZipReader,
  ZipWriter,
  type FileEntry,
} from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import {
  buildLocalSeriesImportFile,
  inspectLocalSeriesImport,
  planLocalSeriesImport,
  readLocalSeriesManifest,
} from './local-series-import';

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);

async function chapter(name: string, pages = 1): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  for (let index = 0; index < pages; index += 1) {
    await writer.add(`${String(index + 1).padStart(3, '0')}.png`, new Uint8ArrayReader(PNG_1X1));
  }
  return new File([await writer.close()], name, { type: 'application/vnd.comicbook+zip' });
}

async function packageFile(name: string, chapters: readonly File[]): Promise<File> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const file of chapters) await writer.add(`회차/${file.name}`, new BlobReader(file));
  return new File([await writer.close()], name, { type: 'application/zip' });
}

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    format: 'image_archive',
    title: '서른의 봄',
    sourceFileName: '서른의 봄.cbz',
    rawText: '',
    normalizedText: '',
    rawTextHash: 'legacy-hash',
    normalizedTextHash: 'normalized',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 1,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

describe('local series import', () => {
  it('treats one outer ZIP containing chapter CBZ files as one work', async () => {
    const outer = await packageFile('서른의 봄.zip', [await chapter('001.cbz'), await chapter('002.cbz', 2)]);
    const inspection = await inspectLocalSeriesImport([outer], []);

    expect(inspection).toMatchObject({
      sourceKind: 'nested_package',
      workTitle: '서른의 봄',
      confidence: 'medium',
    });
    expect(inspection?.releases.map((release) => [release.releaseKey, release.pageCount])).toEqual([
      ['c:1', 1],
      ['c:2', 2],
    ]);
  });

  it('plans only unseen releases and preserves changed same-number releases as conflicts', async () => {
    const first = await inspectLocalSeriesImport([await chapter('서른의 봄 1화.cbz')], []);
    expect(first).toBeDefined();
    const firstPlan = await planLocalSeriesImport(first!, undefined, undefined);
    const existingFile = await buildLocalSeriesImportFile(firstPlan, new AbortController().signal);
    expect(existingFile).toBeDefined();

    const selected = await inspectLocalSeriesImport(
      [await chapter('서른의 봄 1화.cbz', 2), await chapter('서른의 봄 2화.cbz')],
      [novel()],
    );
    const assets = {
      exportSource: vi.fn(async () => ({
        metadata: {} as never,
        blob: existingFile!,
      })),
    } as unknown as BookAssetRepository;
    const plan = await planLocalSeriesImport(selected!, novel(), assets);

    expect(plan.releases.map((release) => [release.releaseKey, release.disposition])).toEqual([
      ['c:1', 'conflict'],
      ['c:2', 'add'],
    ]);
    expect(plan).toMatchObject({ addCount: 1, duplicateCount: 0, conflictCount: 1 });
    const merged = await buildLocalSeriesImportFile(plan, new AbortController().signal);
    expect((await readLocalSeriesManifest(merged!))?.chapters.map((release) => release.title)).toEqual(['1화', '2화']);
  });

  it('skips the same chapter hash even if the selected label differs', async () => {
    const source = await chapter('서른의 봄 1화.cbz');
    const first = await inspectLocalSeriesImport([source], []);
    const existing = await buildLocalSeriesImportFile(
      await planLocalSeriesImport(first!, undefined, undefined),
      new AbortController().signal,
    );
    const duplicate = new File([source], '서른의 봄 제001화.cbz', { type: source.type });
    const selected = await inspectLocalSeriesImport([duplicate], [novel()]);
    const assets = {
      exportSource: vi.fn(async () => ({ metadata: {} as never, blob: existing! })),
    } as unknown as BookAssetRepository;

    await expect(planLocalSeriesImport(selected!, novel(), assets)).resolves.toMatchObject({
      addCount: 0,
      duplicateCount: 1,
      conflictCount: 0,
    });
  });

  it('writes a valid Moya series manifest', async () => {
    const inspection = await inspectLocalSeriesImport(
      [await chapter('서른의 봄 1화.cbz'), await chapter('서른의 봄 2화.cbz')],
      [],
    );
    const aggregate = await buildLocalSeriesImportFile(
      await planLocalSeriesImport(inspection!, undefined, undefined),
      new AbortController().signal,
    );
    const reader = new ZipReader(new BlobReader(aggregate!));
    try {
      const entry = (await reader.getEntries()).find(
        (candidate): candidate is FileEntry => candidate.filename === 'moya-series.json',
      );
      expect(JSON.parse(await entry!.getData!(new TextWriter()))).toMatchObject({
        collection: { title: '서른의 봄' },
        chapters: [{ title: '1화' }, { title: '2화' }],
      });
    } finally {
      await reader.close();
    }
  });
});

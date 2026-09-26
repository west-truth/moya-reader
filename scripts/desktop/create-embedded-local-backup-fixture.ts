import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { IndexedDbBackupRepository } from '../../src/storage/indexeddb-backup-repository';
import {
  getChapters,
  getParagraphs,
  resetReaderDbForTests,
  saveBookmark,
  saveReadingPosition,
  saveParsedNovelImport,
} from '../../src/storage/db';
import { parseDecodedNovelTextForImportCooperatively } from '../../src/services/import/cooperative-import-parser';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Local backup fixture output path is required');
await resetReaderDbForTests();
const source = new TextEncoder().encode('제1화 로컬 백업\n\n기존 로컬 서재의 문단입니다.');
const fileName = '기존 로컬 서재.txt';
const imported = await parseDecodedNovelTextForImportCooperatively(
  fileName,
  { text: new TextDecoder().decode(source), encoding: 'utf-8' },
  `sha256:${createHash('sha256').update(source).digest('hex')}`,
  { chapterSplitMode: 'mixed', yieldControl: async () => undefined },
);
await saveParsedNovelImport(imported, {
  sourceAsset: {
    blob: new Blob([source], { type: 'text/plain' }),
    fileName,
    contentType: 'text/plain',
    contentHash: imported.novel.rawTextHash,
    encoding: 'utf-8',
  },
});
const [chapter] = await getChapters(imported.novel.id);
const [paragraph] = await getParagraphs(chapter.id);
await saveBookmark({
  id: 'native_local_backup_bookmark',
  novelId: imported.novel.id,
  chapterId: chapter.id,
  paragraphId: paragraph.id,
  label: '기존 백업 북마크',
  progress: 0.5,
  scrollTop: 19,
  createdAt: '2026-09-24T00:00:00.000Z',
});
await saveReadingPosition({
  novelId: imported.novel.id,
  chapterId: chapter.id,
  paragraphId: paragraph.id,
  paragraphIndex: paragraph.index,
  chapterProgress: 0.5,
  scrollTop: 19,
});
const { blob } = await new IndexedDbBackupRepository().exportBackup();
await writeFile(outputPath, Buffer.from(await blob.arrayBuffer()));
process.stdout.write(JSON.stringify({ bookId: imported.novel.id, source: Buffer.from(source).toString('base64') }));

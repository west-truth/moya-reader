/** Opt-in destructive fixture test. Run only with disposable DB/S3 named moya-large-import-*. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import sharp from 'sharp';
import pg from 'pg';
import { migrateDatabase } from '../../db/migrate.js';
import { loadConfig } from '../../config.js';
import { processImportJob } from '../import-service.js';
import { createS3Client, getObjectStream, inspectStoredObject } from '../object-storage.js';
import { createStructuredLogger } from '../../observability/logger.js';

if (process.env.MOYA_LARGE_IMPORT_SMOKE !== '1') throw new Error('Opt-in MOYA_LARGE_IMPORT_SMOKE=1 required');
const config = loadConfig();
for (const url of [config.databaseUrl, config.s3.endpoint]) {
  if (!new URL(url).hostname.startsWith('moya-large-import-')) throw new Error('Disposable test hosts required');
}
const format = process.argv[2] === 'epub' ? 'epub' : 'cbz';
const count = format === 'epub' ? 90 : 180;
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const bookId = `large_${format}`;
const append = process.argv.includes('--append');
const id = append ? `${bookId}_append` : bookId;
const fileName = `${id}.${format}`;
const sourcePath = path.join(config.dataDir, fileName);
const uploadDir = path.join(config.dataDir, 'uploads', id);
const profiles: Record<string, unknown>[] = [];
const logger = createStructuredLogger({
  service: 'worker',
  sink: { write: (line) => profiles.push(JSON.parse(line)) },
});
try {
  await migrateDatabase(pool, { migrationsDirectory: process.env.MOYA_TEST_MIGRATIONS_DIR });
  const base = append ? (await pool.query('select * from library_books where id=$1', [bookId])).rows[0] : undefined;
  if (append) assert.ok(base, 'Import the standalone fixture before appending');
  const oldAssets = append
    ? (await pool.query("select id,storage_key from book_assets where book_id=$1 and status='active'", [bookId])).rows
    : [];
  const oldChapters = append ? (await pool.query('select id from chapters where book_id=$1', [bookId])).rows : [];
  await mkdir(uploadDir, { recursive: true });
  await pool.query(
    "insert into users (id,email,display_name) values ('user_dev','fixture@example.com','Fixture') on conflict do nothing",
  );
  // A real, decodable, incompressible image reused under distinct page names.
  const png = await sharp(randomBytes(2048 * 2048 * 3), { raw: { width: 2048, height: 2048, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const writer = new ZipWriter(Writable.toWeb(createWriteStream(sourcePath)), { level: 0, useWebWorkers: false });
  if (format === 'epub') {
    await writer.add('mimetype', new TextReader('application/epub+zip'));
    await writer.add(
      'META-INF/container.xml',
      new TextReader('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    );
    await writer.add(
      'book.opf',
      new TextReader(
        `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Large EPUB</dc:title></metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/>${Array.from({ length: count }, (_, i) => `<item id="image${i}" href="${i}.png" media-type="image/png"${i === 0 ? ' properties="cover-image"' : ''}/>`).join('')}</manifest><spine><itemref idref="text"/></spine></package>`,
      ),
    );
    await writer.add(
      'chapter.xhtml',
      new TextReader(
        `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Large EPUB</h1>${Array.from({ length: count }, (_, i) => `<p>Page ${i}</p><img src="${i}.png"/>`).join('')}</body></html>`,
      ),
    );
  }
  for (let i = 0; i < count; i++) await writer.add(`${i}.png`, new Uint8ArrayReader(png));
  await writer.close();
  const size = (await stat(sourcePath)).size;
  console.log(JSON.stringify({ stage: 'fixture', format, size, images: count }));
  assert.ok(size > (format === 'epub' ? 1024 ** 3 : 2 * 1024 ** 3));
  const source = await openAsBlob(sourcePath);
  const chunkBytes = 16 * 1024 ** 2;
  const chunks = Math.ceil(size / chunkBytes);
  await pool.query(
    `insert into upload_sessions (id,user_id,file_name,content_type,size_bytes,total_chunks,status,client_book_id) values ($1,'user_dev',$2,$3,$4,$5,'queued',$6)`,
    [id, fileName, format === 'epub' ? 'application/epub+zip' : 'application/vnd.comicbook+zip', size, chunks, bookId],
  );
  for (let i = 0; i < chunks; i++) {
    const bytes = new Uint8Array(
      await source.slice(i * chunkBytes, Math.min(size, (i + 1) * chunkBytes)).arrayBuffer(),
    );
    const chunkPath = path.join(uploadDir, `${i}.part`);
    const file = await open(chunkPath, 'w');
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await pool.query('insert into upload_chunks (upload_id,chunk_index,size_bytes,storage_path) values ($1,$2,$3,$4)', [
      id,
      i,
      bytes.length,
      chunkPath,
    ]);
  }
  if (append) {
    // The worker verifies the upload hash itself; normal API sessions also send this hash at init.
    await pool.query(
      "update upload_sessions set import_mode='append_local_archive',base_active_content_revision_id=$2 where id=$1",
      [id, base.active_content_revision_id],
    );
  }
  await rm(sourcePath);
  await pool.query(
    "insert into import_jobs (id,user_id,upload_id,status,stage,total_bytes) values ($1,'user_dev',$1,'queued','queued',$2)",
    [id, size],
  );
  const started = performance.now();
  await processImportJob(pool, config, id, id, undefined, logger);
  const job = (await pool.query('select status,error_message from import_jobs where id=$1', [id])).rows[0];
  assert.equal(job.status, 'done', job.error_message);
  const assets = (
    await pool.query("select kind,storage_key,content_hash from book_assets where book_id=$1 and status='active'", [
      bookId,
    ])
  ).rows;
  assert.equal(
    assets.filter((a) => a.kind === (format === 'epub' ? 'epub_resource' : 'document_page')).length,
    count * (append ? 2 : 1),
  );
  const s3 = createS3Client(config);
  const original = (
    await pool.query(
      'select storage_key from book_objects where id=(select object_id from library_books where id=$1)',
      [bookId],
    )
  ).rows[0];
  if (!append) assert.equal((await inspectStoredObject(s3, config, original.storage_key))?.byteLength, size);
  if (append) {
    for (const asset of oldAssets)
      assert.deepEqual(
        (await pool.query('select id,storage_key from book_assets where id=$1', [asset.id])).rows[0],
        asset,
      );
    for (const chapter of oldChapters)
      assert.ok((await pool.query('select id from chapters where id=$1', [chapter.id])).rows[0]);
    const parts = (
      await pool.query("select storage_key,byte_length from book_assets where book_id=$1 and kind='source_part'", [
        bookId,
      ])
    ).rows;
    assert.equal(parts.length, 2);
    for (const part of parts)
      assert.equal((await inspectStoredObject(s3, config, part.storage_key))?.byteLength, Number(part.byte_length));
    console.log(
      JSON.stringify({
        stage: 'append-preservation',
        assets: oldAssets.length,
        chapters: oldChapters.length,
        sourceParts: parts.length,
      }),
    );
  }
  const images = assets.filter((a) => a.kind === (format === 'epub' ? 'epub_resource' : 'document_page'));
  for (const asset of [images[0], images.at(-1)]) {
    const stream = await getObjectStream(s3, config, asset.storage_key);
    const buffers: Buffer[] = [];
    for await (const chunk of stream.body) buffers.push(Buffer.from(chunk));
    assert.equal((await sharp(Buffer.concat(buffers)).metadata()).width, 2048);
  }
  const remaining = await stat(uploadDir).then(
    () => true,
    () => false,
  );
  assert.equal(remaining, false, 'temporary upload directory not cleaned');
  console.log(
    JSON.stringify({
      stage: 'complete',
      format,
      append,
      size,
      images: count,
      durationMs: Math.round(performance.now() - started),
      maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      cgroupPeakBytes: await readFile('/sys/fs/cgroup/memory.peak', 'utf8').catch(() => ''),
      profiles,
    }),
  );
} finally {
  await pool.end();
}

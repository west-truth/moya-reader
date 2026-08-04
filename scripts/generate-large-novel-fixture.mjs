#!/usr/bin/env node
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generatePhase6LargeNovelFixture } from './performance/phase6-large-novel-fixture.mjs';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(option(name, String(fallback)), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function write(stream, text) {
  if (stream.write(text)) return Promise.resolve();
  return once(stream, 'drain').then(() => undefined);
}

const profile = option('profile', 'legacy');
const output = resolve(
  option(
    'output',
    profile === 'phase6' ? 'fixtures/generated/phase6-reader-20mb.txt' : 'fixtures/generated/large-novel.txt',
  ),
);
const targetMb = positiveInteger('mb', profile === 'phase6' ? 20 : 50);

if (profile === 'phase6') {
  const metadata = await generatePhase6LargeNovelFixture({
    outputPath: output,
    targetBytes: targetMb * 1024 * 1024,
    regularChapterCount: positiveInteger('chapters', 1024),
    largeChapterBytes: positiveInteger('largeChapterMb', Math.min(8, Math.max(1, targetMb - 1))) * 1024 * 1024,
    paragraphChars: positiveInteger('paragraphChars', 384),
  });
  console.log(`Generated ${metadata.outputPath}`);
  console.log(`Size: ${(metadata.actualBytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`SHA-256: ${metadata.sha256}`);
  console.log(`Chapters: ${metadata.chapterCount}; paragraphs: ${metadata.paragraphCount}`);
  console.log(`Heading families: ${Object.keys(metadata.headingFamilyCounts).join(', ')}`);
  console.log(
    `Largest chapter: ${metadata.largestChapter.index} (${metadata.largestChapter.paragraphs} paragraphs, ${(metadata.largestChapter.bytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
} else {
  const chapterCount = positiveInteger('chapters', 80);
  const paragraphChars = positiveInteger('paragraphChars', 320);
  const paragraphsPerChapter = positiveInteger('paragraphsPerChapter', 80);
  const targetBytes = targetMb * 1024 * 1024;
  const paragraphSeed =
    'This generated paragraph is intentionally repetitive so reader import, paging, search, and scrolling can be tested with a large local TXT fixture. ';

  await mkdir(dirname(output), { recursive: true });

  const stream = createWriteStream(output, { encoding: 'utf8' });
  let bytesWritten = 0;
  let chapter = 1;
  let paragraph = 1;

  while (bytesWritten < targetBytes) {
    const heading = `${chapter}화 Generated Load Test Chapter ${chapter}\n\n`;
    await write(stream, heading);
    bytesWritten += Buffer.byteLength(heading);

    const base = paragraphSeed.repeat(Math.ceil(paragraphChars / paragraphSeed.length)).slice(0, paragraphChars);
    for (let index = 0; index < paragraphsPerChapter && bytesWritten < targetBytes; index += 1) {
      const text = `${base} marker-${chapter}-${paragraph}\n\n`;
      await write(stream, text);
      bytesWritten += Buffer.byteLength(text);
      paragraph += 1;
    }

    chapter = chapter >= chapterCount ? 1 : chapter + 1;
  }

  stream.end();
  await once(stream, 'finish');

  const actualMb = (bytesWritten / 1024 / 1024).toFixed(2);
  console.log(`Generated ${output}`);
  console.log(`Size: ${actualMb} MB`);
  console.log(`Paragraphs: ${paragraph - 1}`);
}

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHASE6_FIXTURE_BYTES, generatePhase6LargeNovelFixture } from './phase6-large-novel-fixture.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Phase 6 deterministic novel fixture', () => {
  it('is byte-for-byte deterministic and covers mixed heading families plus a large chapter', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'noveldesk-fixture-test-'));
    temporaryDirectories.push(directory);
    const firstPath = resolve(directory, 'first.txt');
    const secondPath = resolve(directory, 'second.txt');
    const options = {
      targetBytes: 512 * 1024,
      regularChapterCount: 48,
      largeChapterBytes: 192 * 1024,
      paragraphChars: 192,
    };
    const first = await generatePhase6LargeNovelFixture({ ...options, outputPath: firstPath });
    const second = await generatePhase6LargeNovelFixture({ ...options, outputPath: secondPath });

    expect(first.actualBytes).toBe(options.targetBytes);
    expect(second.actualBytes).toBe(options.targetBytes);
    expect(first.sha256).toBe(second.sha256);
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(first.chapterCount).toBe(options.regularChapterCount + 1);
    expect(Object.keys(first.headingFamilyCounts).length).toBeGreaterThanOrEqual(6);
    expect(first.largestChapter.index).toBe(1);
    expect(first.largestChapter.bytes).toBeGreaterThanOrEqual(options.largeChapterBytes);
    expect(first.largestChapter.paragraphs).toBeGreaterThan(500);
  });

  it('writes the exact release fixture size with the required chapter and large-chapter shape', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'noveldesk-release-fixture-test-'));
    temporaryDirectories.push(directory);
    const outputPath = resolve(directory, 'release-20mb.txt');
    const fixture = await generatePhase6LargeNovelFixture({ outputPath });

    expect(fixture.actualBytes).toBe(PHASE6_FIXTURE_BYTES);
    expect((await stat(outputPath)).size).toBe(PHASE6_FIXTURE_BYTES);
    expect(fixture.chapterCount).toBe(1025);
    expect(Object.keys(fixture.headingFamilyCounts)).toHaveLength(12);
    expect(fixture.largestChapter.index).toBe(1);
    expect(fixture.largestChapter.paragraphs).toBeGreaterThan(15000);
  }, 30000);
});

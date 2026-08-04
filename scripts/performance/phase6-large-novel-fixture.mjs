import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const PHASE6_FIXTURE_BYTES = 20 * 1024 * 1024;
export const PHASE6_REGULAR_CHAPTERS = 1024;
export const PHASE6_LARGE_CHAPTER_BYTES = 8 * 1024 * 1024;
export const PHASE6_COMMON_QUERY = 'common-token';
export const PHASE6_UNIQUE_QUERY = 'unique-cancel-target';

const BODY_SEED =
  'This deterministic paragraph exercises worker import, IndexedDB paging, reader virtualization, and bounded search. ';

const HEADING_FAMILIES = [
  ['angle_hwa', (chapter) => `<${chapter}\ud654 Phase 6 \uc131\ub2a5 \uce21\uc815>`],
  ['numbered_hwa_jang', (chapter) => `${chapter}\ud654. Phase 6 \uc81c\ubaa9`],
  ['title_prefix_hwa', (chapter) => `NovelDesk ${chapter}\ud654`],
  ['leading_5digits', (chapter) => `${String(chapter).padStart(5, '0')} <-- NovelDesk -->`],
  ['bracket_number', (chapter) => `[${String(chapter).padStart(3, '0')}]`],
  ['number_underscore', (chapter) => `${String(chapter).padStart(3, '0')}_Performance_Title`],
  ['dash_episode', (chapter) => `${String(chapter).padStart(3, '0')} - Performance Title`],
  ['dot_episode', (chapter) => `${chapter}. Performance Title`],
  ['number_only', (chapter) => String(chapter).padStart(5, '0')],
  ['hash_number', (chapter) => `#${chapter} - Performance Title`],
  ['ep_title', (chapter) => `Episode ${chapter} - Performance Title`],
  ['braced_episode', (chapter) => `{${String(chapter).padStart(3, '0')} - Performance Title}`],
];

function headingFor(chapter) {
  if (chapter === 1) return { family: 'angle_hwa', text: '<1\ud654 Phase 6 \ub300\ud615 \uc7a5>' };
  const familyIndex = Math.floor((chapter - 2) / 8) % HEADING_FAMILIES.length;
  const [family, render] = HEADING_FAMILIES[familyIndex];
  return { family, text: render(chapter) };
}

function paragraphText(chapter, paragraph, paragraphChars, includeUniqueQuery = false) {
  const prefix = `${PHASE6_COMMON_QUERY} chapter-${String(chapter).padStart(4, '0')} paragraph-${String(paragraph).padStart(6, '0')}`;
  const sentinel = includeUniqueQuery ? ` ${PHASE6_UNIQUE_QUERY}` : '';
  const seed = `${prefix}${sentinel} ${BODY_SEED}`;
  return `${seed.repeat(Math.ceil(paragraphChars / seed.length)).slice(0, paragraphChars)}\n\n`;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

export async function generatePhase6LargeNovelFixture(options) {
  const outputPath = resolve(options.outputPath);
  const targetBytes = options.targetBytes ?? PHASE6_FIXTURE_BYTES;
  const regularChapterCount = options.regularChapterCount ?? PHASE6_REGULAR_CHAPTERS;
  const requestedLargeChapterBytes = options.largeChapterBytes ?? PHASE6_LARGE_CHAPTER_BYTES;
  const paragraphChars = options.paragraphChars ?? 384;
  const requestedChapterCount = regularChapterCount + 1;

  if (!Number.isSafeInteger(targetBytes) || targetBytes < 64 * 1024) {
    throw new Error('targetBytes must be an integer of at least 64 KiB');
  }
  if (!Number.isSafeInteger(regularChapterCount) || regularChapterCount < 12) {
    throw new Error('regularChapterCount must be an integer of at least 12');
  }
  if (!Number.isSafeInteger(paragraphChars) || paragraphChars < 128) {
    throw new Error('paragraphChars must be an integer of at least 128');
  }

  const minimumRegularBudget = regularChapterCount * (paragraphChars + 64);
  const largeChapterBudget = Math.min(
    requestedLargeChapterBytes,
    Math.max(32 * 1024, targetBytes - minimumRegularBudget),
  );

  await mkdir(dirname(outputPath), { recursive: true });
  const stream = createWriteStream(outputPath, { encoding: 'utf8' });
  let bytesWritten = 0;
  let totalParagraphs = 0;
  let chaptersWritten = 0;
  let largestChapter = { index: 0, bytes: 0, paragraphs: 0 };
  const headingFamilyCounts = {};

  const append = async (text) => {
    if (stream.write(text)) {
      bytesWritten += Buffer.byteLength(text);
      return;
    }
    bytesWritten += Buffer.byteLength(text);
    await once(stream, 'drain');
  };

  const appendChapter = async (chapter, chapterByteBudget) => {
    const chapterStart = bytesWritten;
    let chapterParagraphs = 0;
    const heading = headingFor(chapter);
    chaptersWritten += 1;
    headingFamilyCounts[heading.family] = (headingFamilyCounts[heading.family] ?? 0) + 1;
    await append(`${heading.text}\n\n`);

    while (bytesWritten < targetBytes && bytesWritten - chapterStart < chapterByteBudget) {
      const next = paragraphText(
        chapter,
        chapterParagraphs + 1,
        paragraphChars,
        chapter === 1 && chapterParagraphs === 0,
      );
      const remaining = targetBytes - bytesWritten;
      if (Buffer.byteLength(next) > remaining) {
        if (remaining > 0) await append('x'.repeat(remaining));
        break;
      }
      await append(next);
      chapterParagraphs += 1;
      totalParagraphs += 1;
    }

    const chapterBytes = bytesWritten - chapterStart;
    if (chapterBytes > largestChapter.bytes) {
      largestChapter = { index: chapter, bytes: chapterBytes, paragraphs: chapterParagraphs };
    }
  };

  await appendChapter(1, largeChapterBudget);
  for (let chapter = 2; chapter <= requestedChapterCount && bytesWritten < targetBytes; chapter += 1) {
    const chaptersRemaining = requestedChapterCount - chapter + 1;
    const chapterBudget = Math.max(paragraphChars + 64, Math.floor((targetBytes - bytesWritten) / chaptersRemaining));
    await appendChapter(chapter, chapterBudget);
  }

  if (bytesWritten < targetBytes) await append('x'.repeat(targetBytes - bytesWritten));
  stream.end();
  await once(stream, 'finish');

  return {
    profile: 'phase6-20mb-reader',
    outputPath,
    targetBytes,
    actualBytes: bytesWritten,
    sha256: await hashFile(outputPath),
    chapterCount: chaptersWritten,
    paragraphCount: totalParagraphs,
    largestChapter,
    headingFamilyCounts,
    commonQuery: PHASE6_COMMON_QUERY,
    uniqueQuery: PHASE6_UNIQUE_QUERY,
  };
}

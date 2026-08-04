import { describe, expect, it } from 'vitest';
import { hashSync } from '../domain/hash';
import { isIntegrityHash } from '../domain/id-hash-contract';
import { parseDecodedNovelTextForImport, parseNovelFile, parseNovelFileForImport } from '../domain/parser';
import { parsedChapterId, parsedNovelId, parsedParagraphId } from '../domain/parser/entity-identities';
import type { Paragraph, ParsedNovelImportChapterSource } from '../domain/types';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function collectParagraphs(source: ParsedNovelImportChapterSource): Promise<Paragraph[]> {
  const paragraphs: Paragraph[] = [];
  for await (const item of source) paragraphs.push(...item.paragraphs);
  return paragraphs;
}

describe('parser persistent identities', () => {
  it('constructs deterministic v2 IDs and tagged content hashes', async () => {
    const source = `Chapter 1 - Start\n\nFirst paragraph.\n\nChapter 2 - End\n\nSecond paragraph.`;
    const parsed = await parseNovelFile('identity.txt', toBuffer(source), 'utf-8');

    expect(parsed.novel.id).toBe(parsedNovelId('identity.txt', parsed.novel.normalizedTextHash));
    expect(parsed.novel.id).toMatch(/^novel_[0-9a-f]{32}$/);
    expect(isIntegrityHash(parsed.novel.rawTextHash)).toBe(true);
    expect(isIntegrityHash(parsed.novel.normalizedTextHash)).toBe(true);

    for (const chapter of parsed.chapters) {
      expect(chapter.id).toBe(parsedChapterId(parsed.novel.id, chapter.index, chapter.title));
      expect(isIntegrityHash(chapter.textHash)).toBe(true);
    }
    for (const paragraph of parsed.paragraphs) {
      expect(paragraph.id).toBe(
        parsedParagraphId(parsed.novel.id, paragraph.chapterId, paragraph.index - 1, paragraph.text),
      );
      expect(isIntegrityHash(paragraph.textHash)).toBe(true);
    }
  });

  it('keeps full and streaming parser identity construction identical', async () => {
    const source = `제 1화 시작\n\n첫 문단입니다.\n\n제 2화 끝\n\n마지막 문단입니다.`;
    const buffer = toBuffer(source);
    const full = await parseNovelFile('parity.txt', buffer, 'utf-8');
    const streaming = await parseNovelFileForImport('parity.txt', buffer, 'utf-8');
    const streamingParagraphs = await collectParagraphs(streaming.consumeChapterParagraphs());

    expect(full.chapters).toHaveLength(2);
    expect(streaming.novel.id).toBe(full.novel.id);
    expect(streaming.novel.rawTextHash).toBe(full.novel.rawTextHash);
    expect(streaming.novel.normalizedTextHash).toBe(full.novel.normalizedTextHash);
    expect(streaming.chapters.map(({ id, textHash }) => ({ id, textHash }))).toEqual(
      full.chapters.map(({ id, textHash }) => ({ id, textHash })),
    );
    expect(streamingParagraphs.map(({ id, textHash }) => ({ id, textHash }))).toEqual(
      full.paragraphs.map(({ id, textHash }) => ({ id, textHash })),
    );
  });

  it('tags a legacy worker SHA-256 digest without changing its bytes', async () => {
    const legacySha256 = 'a'.repeat(64);
    const parsed = await parseDecodedNovelTextForImport(
      'worker.txt',
      { text: 'single chapter body', encoding: 'utf-8' },
      legacySha256,
    );

    expect(parsed.novel.rawTextHash).toBe(`sha256:${legacySha256}`);
  });

  it('prevents known FNV collisions and isolates identical content across books', () => {
    expect(hashSync('costarring')).toBe(hashSync('liquid'));
    expect(parsedParagraphId('novel_same', 'chapter_same', 0, 'costarring')).not.toBe(
      parsedParagraphId('novel_same', 'chapter_same', 0, 'liquid'),
    );

    const chapterA = parsedChapterId('novel_a', 1, 'Same title');
    const chapterB = parsedChapterId('novel_b', 1, 'Same title');
    expect(chapterA).not.toBe(chapterB);
    expect(parsedParagraphId('novel_a', chapterA, 0, 'Same text')).not.toBe(
      parsedParagraphId('novel_b', chapterB, 0, 'Same text'),
    );
  });
});

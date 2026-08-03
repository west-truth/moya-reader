import type { Chapter, ChapterSplitMode, Paragraph } from '@noveldesk/contracts';
import { integrityHash, persistentId128 } from './id-hash-contract';
import { assembleChapterRanges } from './parser/chapter-range-assembler';
import { iterateParagraphsInRange } from './parser/paragraph-builder';

export type ChapterStructureCommand =
  | { kind: 'rename'; chapterId: string; title: string }
  | { kind: 'split'; chapterId: string; sourceOffset: number; title?: string }
  | { kind: 'merge_next'; chapterId: string; titlePolicy: 'first' | 'second' | 'custom'; title?: string }
  | { kind: 'reparse_range'; startOffset: number; endOffset?: number; splitMode: ChapterSplitMode };

export interface ChapterStructureSnapshot {
  readonly bookId: string;
  readonly bookTitle: string;
  readonly baseContentRevisionId: string;
  readonly sourceText: string;
  readonly chapters: readonly Chapter[];
  readonly paragraphs: readonly Paragraph[];
}

export interface ChapterSplitCandidate {
  readonly paragraphId: string;
  readonly paragraphIndex: number;
  readonly label: string;
  readonly sourceOffset: number;
}

export interface ChapterStructureChapterView {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly rawStartOffset: number;
  readonly rawEndOffset: number;
  readonly paragraphCount: number;
  readonly characterCount: number;
  readonly sourcePreview: string;
  readonly splitCandidates: readonly ChapterSplitCandidate[];
}

export interface ChapterStructureTransformResult {
  readonly chapters: Chapter[];
  readonly paragraphs: Paragraph[];
  readonly affectedChapterIds: readonly string[];
}

interface LocatedParagraph {
  readonly paragraph: Paragraph;
  readonly absoluteStart: number;
  readonly absoluteEnd: number;
}

function chaptersSorted(chapters: readonly Chapter[]): Chapter[] {
  return [...chapters].sort((left, right) => left.index - right.index);
}

function paragraphsByChapter(paragraphs: readonly Paragraph[]): Map<string, Paragraph[]> {
  const result = new Map<string, Paragraph[]>();
  for (const paragraph of paragraphs) {
    const rows = result.get(paragraph.chapterId) ?? [];
    rows.push(paragraph);
    result.set(paragraph.chapterId, rows);
  }
  for (const rows of result.values()) rows.sort((left, right) => left.index - right.index);
  return result;
}

function locateParagraphs(sourceText: string, chapter: Chapter, paragraphs: readonly Paragraph[]): LocatedParagraph[] {
  let cursor = chapter.rawStartOffset;
  return paragraphs.map((paragraph) => {
    let start = sourceText.indexOf(paragraph.text, cursor);
    if (start < chapter.rawStartOffset || start + paragraph.text.length > chapter.rawEndOffset) {
      start = chapter.rawStartOffset + paragraph.startOffsetInChapter;
    }
    const end = start + paragraph.text.length;
    cursor = Math.max(cursor, end);
    return { paragraph, absoluteStart: start, absoluteEnd: end };
  });
}

function chapterFromParagraphs(
  base: Chapter,
  input: {
    id?: string;
    title?: string;
    rawStartOffset: number;
    rawEndOffset: number;
    paragraphs: readonly LocatedParagraph[];
    updatedAt: string;
  },
): { chapter: Chapter; paragraphs: Paragraph[] } {
  const bodyStart = input.paragraphs[0]?.absoluteStart ?? input.rawStartOffset;
  const normalizedText = input.paragraphs.map((item) => item.paragraph.text).join('\n\n');
  const chapterId = input.id ?? base.id;
  const paragraphs = input.paragraphs.map((item, offset) => ({
    ...item.paragraph,
    chapterId,
    index: offset + 1,
    startOffsetInChapter: Math.max(0, item.absoluteStart - bodyStart),
    endOffsetInChapter: Math.max(0, item.absoluteEnd - bodyStart),
  }));
  return {
    chapter: {
      ...base,
      id: chapterId,
      title: input.title?.trim() || base.title,
      normalizedText,
      textHash: integrityHash(normalizedText),
      rawStartOffset: input.rawStartOffset,
      rawEndOffset: input.rawEndOffset,
      characterCount: normalizedText.length,
      paragraphCount: paragraphs.length,
      updatedAt: input.updatedAt,
    },
    paragraphs,
  };
}

function reindex(chapters: Chapter[], paragraphs: Paragraph[]): { chapters: Chapter[]; paragraphs: Paragraph[] } {
  const byChapter = paragraphsByChapter(paragraphs);
  const nextChapters = chapters.map((chapter, index) => ({ ...chapter, index: index + 1 }));
  return {
    chapters: nextChapters,
    paragraphs: nextChapters.flatMap((chapter) => byChapter.get(chapter.id) ?? []),
  };
}

function assertSourceCoverage(sourceLength: number, chapters: readonly Chapter[]): void {
  let offset = 0;
  for (const chapter of chaptersSorted(chapters)) {
    if (chapter.rawStartOffset !== offset || chapter.rawEndOffset < chapter.rawStartOffset) {
      throw new Error('Chapter structure no longer covers the source continuously');
    }
    offset = chapter.rawEndOffset;
  }
  if (offset !== sourceLength) throw new Error('Chapter structure does not cover the complete source');
}

function rename(
  chapters: Chapter[],
  paragraphs: Paragraph[],
  command: Extract<ChapterStructureCommand, { kind: 'rename' }>,
  updatedAt: string,
): ChapterStructureTransformResult {
  const title = command.title.trim();
  if (!title) throw new Error('Chapter title cannot be empty');
  let found = false;
  const next = chapters.map((chapter) => {
    if (chapter.id !== command.chapterId) return chapter;
    found = true;
    return { ...chapter, title, updatedAt };
  });
  if (!found) throw new Error(`Chapter ${command.chapterId} was not found`);
  return { chapters: next, paragraphs, affectedChapterIds: [command.chapterId] };
}

function split(
  snapshot: ChapterStructureSnapshot,
  chapters: Chapter[],
  paragraphs: Paragraph[],
  command: Extract<ChapterStructureCommand, { kind: 'split' }>,
  updatedAt: string,
): ChapterStructureTransformResult {
  const chapterIndex = chapters.findIndex((chapter) => chapter.id === command.chapterId);
  if (chapterIndex < 0) throw new Error(`Chapter ${command.chapterId} was not found`);
  const chapter = chapters[chapterIndex];
  const located = locateParagraphs(snapshot.sourceText, chapter, paragraphsByChapter(paragraphs).get(chapter.id) ?? []);
  const splitIndex = located.findIndex((item) => item.absoluteStart === command.sourceOffset);
  if (splitIndex <= 0) throw new Error('Split offset must be the start of a non-first paragraph');
  const first = chapterFromParagraphs(chapter, {
    rawStartOffset: chapter.rawStartOffset,
    rawEndOffset: command.sourceOffset,
    paragraphs: located.slice(0, splitIndex),
    updatedAt,
  });
  const nextTitle = command.title?.trim() || `${chapter.title} (2)`;
  const nextId = persistentId128('chapter', [
    snapshot.bookId,
    snapshot.baseContentRevisionId,
    String(command.sourceOffset),
    nextTitle,
  ]);
  const second = chapterFromParagraphs(chapter, {
    id: nextId,
    title: nextTitle,
    rawStartOffset: command.sourceOffset,
    rawEndOffset: chapter.rawEndOffset,
    paragraphs: located.slice(splitIndex),
    updatedAt,
  });
  const reindexed = reindex(
    [...chapters.slice(0, chapterIndex), first.chapter, second.chapter, ...chapters.slice(chapterIndex + 1)],
    [
      ...paragraphs.filter((paragraph) => paragraph.chapterId !== chapter.id),
      ...first.paragraphs,
      ...second.paragraphs,
    ],
  );
  return { ...reindexed, affectedChapterIds: [chapter.id, nextId] };
}

function mergeNext(
  snapshot: ChapterStructureSnapshot,
  chapters: Chapter[],
  paragraphs: Paragraph[],
  command: Extract<ChapterStructureCommand, { kind: 'merge_next' }>,
  updatedAt: string,
): ChapterStructureTransformResult {
  const chapterIndex = chapters.findIndex((chapter) => chapter.id === command.chapterId);
  const first = chapters[chapterIndex];
  const second = chapters[chapterIndex + 1];
  if (!first || !second) throw new Error('Only adjacent chapters can be merged');
  const byChapter = paragraphsByChapter(paragraphs);
  const located = [
    ...locateParagraphs(snapshot.sourceText, first, byChapter.get(first.id) ?? []),
    ...locateParagraphs(snapshot.sourceText, second, byChapter.get(second.id) ?? []),
  ];
  const title =
    command.titlePolicy === 'second'
      ? second.title
      : command.titlePolicy === 'custom'
        ? command.title?.trim()
        : first.title;
  if (!title) throw new Error('Merged chapter title cannot be empty');
  const merged = chapterFromParagraphs(first, {
    title,
    rawStartOffset: first.rawStartOffset,
    rawEndOffset: second.rawEndOffset,
    paragraphs: located,
    updatedAt,
  });
  const reindexed = reindex(
    [...chapters.slice(0, chapterIndex), merged.chapter, ...chapters.slice(chapterIndex + 2)],
    [
      ...paragraphs.filter((paragraph) => paragraph.chapterId !== first.id && paragraph.chapterId !== second.id),
      ...merged.paragraphs,
    ],
  );
  return { ...reindexed, affectedChapterIds: [first.id, second.id] };
}

function reparseRange(
  snapshot: ChapterStructureSnapshot,
  chapters: Chapter[],
  paragraphs: Paragraph[],
  command: Extract<ChapterStructureCommand, { kind: 'reparse_range' }>,
  updatedAt: string,
): ChapterStructureTransformResult {
  const startIndex = chapters.findIndex((chapter) => chapter.rawStartOffset === command.startOffset);
  const endOffset = command.endOffset ?? snapshot.sourceText.length;
  const endIndex = chapters.findIndex((chapter) => chapter.rawEndOffset === endOffset);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error('Reparse range must align with existing chapter boundaries');
  }
  const source = snapshot.sourceText.slice(command.startOffset, endOffset);
  const fallbackTitle = chapters[startIndex]?.title || snapshot.bookTitle;
  const ranges = assembleChapterRanges(source, fallbackTitle, { chapterSplitMode: command.splitMode });
  const generatedChapters: Chapter[] = [];
  const generatedParagraphs: Paragraph[] = [];
  for (const [offset, range] of ranges.entries()) {
    const rawStartOffset = command.startOffset + range.normalizedStartOffset;
    const rawEndOffset = command.startOffset + range.normalizedEndOffset;
    const bodyStart = command.startOffset + range.normalizedBodyStartOffset;
    const bodyEnd = command.startOffset + range.normalizedBodyEndOffset;
    const chapterId = persistentId128('chapter', [
      snapshot.bookId,
      snapshot.baseContentRevisionId,
      String(rawStartOffset),
      range.title,
    ]);
    const nextParagraphs = Array.from(
      iterateParagraphsInRange(snapshot.bookId, chapterId, snapshot.sourceText, bodyStart, bodyEnd),
    );
    const body = snapshot.sourceText.slice(bodyStart, bodyEnd);
    generatedChapters.push({
      id: chapterId,
      novelId: snapshot.bookId,
      index: offset + 1,
      title: range.title,
      normalizedText: body,
      textHash: integrityHash(body),
      rawStartOffset,
      rawEndOffset,
      characterCount: body.length,
      paragraphCount: nextParagraphs.length,
      createdAt: updatedAt,
      updatedAt,
    });
    generatedParagraphs.push(...nextParagraphs);
  }
  const replacedIds = new Set(chapters.slice(startIndex, endIndex + 1).map((chapter) => chapter.id));
  const reindexed = reindex(
    [...chapters.slice(0, startIndex), ...generatedChapters, ...chapters.slice(endIndex + 1)],
    [...paragraphs.filter((paragraph) => !replacedIds.has(paragraph.chapterId)), ...generatedParagraphs],
  );
  return {
    ...reindexed,
    affectedChapterIds: [...replacedIds, ...generatedChapters.map((chapter) => chapter.id)],
  };
}

export function applyChapterStructureCommands(
  snapshot: ChapterStructureSnapshot,
  commands: readonly ChapterStructureCommand[],
  updatedAt = new Date().toISOString(),
): ChapterStructureTransformResult {
  if (!snapshot.baseContentRevisionId) throw new Error('Chapter structure editing requires an active content revision');
  let chapters = chaptersSorted(snapshot.chapters);
  let paragraphs = [...snapshot.paragraphs];
  const affected = new Set<string>();
  assertSourceCoverage(snapshot.sourceText.length, chapters);
  for (const command of commands) {
    const result =
      command.kind === 'rename'
        ? rename(chapters, paragraphs, command, updatedAt)
        : command.kind === 'split'
          ? split(snapshot, chapters, paragraphs, command, updatedAt)
          : command.kind === 'merge_next'
            ? mergeNext(snapshot, chapters, paragraphs, command, updatedAt)
            : reparseRange(snapshot, chapters, paragraphs, command, updatedAt);
    chapters = result.chapters;
    paragraphs = result.paragraphs;
    result.affectedChapterIds.forEach((id) => affected.add(id));
    assertSourceCoverage(snapshot.sourceText.length, chapters);
  }
  return { chapters, paragraphs, affectedChapterIds: [...affected] };
}

export function chapterStructureViews(snapshot: ChapterStructureSnapshot): ChapterStructureChapterView[] {
  const byChapter = paragraphsByChapter(snapshot.paragraphs);
  return chaptersSorted(snapshot.chapters).map((chapter) => {
    const located = locateParagraphs(snapshot.sourceText, chapter, byChapter.get(chapter.id) ?? []);
    return {
      id: chapter.id,
      index: chapter.index,
      title: chapter.title,
      rawStartOffset: chapter.rawStartOffset,
      rawEndOffset: chapter.rawEndOffset,
      paragraphCount: chapter.paragraphCount,
      characterCount: chapter.characterCount,
      sourcePreview: snapshot.sourceText.slice(chapter.rawStartOffset, chapter.rawEndOffset).trim().slice(0, 320),
      splitCandidates: located.slice(1).map((item) => ({
        paragraphId: item.paragraph.id,
        paragraphIndex: item.paragraph.index,
        label: item.paragraph.text.slice(0, 80),
        sourceOffset: item.absoluteStart,
      })),
    };
  });
}

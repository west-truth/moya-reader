import { matchesIntegrityHash } from '../../domain/id-hash-contract';
import type { LabeledSegment, Paragraph } from '../../domain/types';
import type { RevisionParagraphPageRow, RevisionParagraphRefRow } from '../content-revision-store';
import type { NativeAnalysisStagedOutput } from './types';

interface PageParagraphSource {
  readonly pageIndex: number;
  readonly paragraph: Paragraph;
}

export type NativeLabelSourceIndexResult =
  | { readonly ok: true; readonly paragraphTextById: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string; readonly stale: boolean };

function sourceIndexFailure(reason: string, stale = false): NativeLabelSourceIndexResult {
  return { ok: false, reason, stale };
}

export function buildNativeLabelSourceIndex(
  artifact: NativeAnalysisStagedOutput,
  contentRevisionId: string,
  paragraphRows: readonly RevisionParagraphRefRow[],
  pageRows: readonly RevisionParagraphPageRow[],
): NativeLabelSourceIndexResult {
  if (artifact.plannedParagraphIds.length === 0) return sourceIndexFailure('planned_paragraphs_empty');

  const planned = new Set(artifact.plannedParagraphIds);
  const paragraphRowsById = new Map<string, RevisionParagraphRefRow>();
  for (const row of paragraphRows) {
    if (
      paragraphRowsById.has(row.id) ||
      row.contentRevisionId !== contentRevisionId ||
      row.novelId !== artifact.novelId ||
      row.chapterId !== artifact.chapterId ||
      row.textStorageMode !== 'page' ||
      !Number.isSafeInteger(row.pageIndex)
    ) {
      return sourceIndexFailure('paragraph_source_invalid');
    }
    paragraphRowsById.set(row.id, row);
  }
  if ([...planned].some((paragraphId) => !paragraphRowsById.has(paragraphId))) {
    return sourceIndexFailure('planned_paragraphs_stale', true);
  }

  const sourceById = new Map<string, PageParagraphSource>();
  for (const page of pageRows) {
    if (
      page.contentRevisionId !== contentRevisionId ||
      page.novelId !== artifact.novelId ||
      page.chapterId !== artifact.chapterId ||
      !Number.isSafeInteger(page.pageIndex) ||
      !Array.isArray(page.paragraphs)
    ) {
      return sourceIndexFailure('paragraph_source_invalid');
    }
    for (const paragraph of page.paragraphs) {
      if (
        sourceById.has(paragraph.id) ||
        paragraph.novelId !== artifact.novelId ||
        paragraph.chapterId !== artifact.chapterId ||
        typeof paragraph.text !== 'string' ||
        !matchesIntegrityHash(paragraph.textHash, paragraph.text)
      ) {
        return sourceIndexFailure('paragraph_source_invalid');
      }
      sourceById.set(paragraph.id, { pageIndex: page.pageIndex, paragraph });
    }
  }

  const paragraphTextById = new Map<string, string>();
  for (const row of paragraphRows) {
    const source = sourceById.get(row.id);
    if (
      !source ||
      source.pageIndex !== row.pageIndex ||
      source.paragraph.index !== row.index ||
      source.paragraph.startOffsetInChapter !== row.startOffsetInChapter ||
      source.paragraph.endOffsetInChapter !== row.endOffsetInChapter ||
      !matchesIntegrityHash(row.textHash, source.paragraph.text)
    ) {
      return sourceIndexFailure('paragraph_source_invalid');
    }
    paragraphTextById.set(row.id, source.paragraph.text);
  }
  if ([...planned].some((paragraphId) => !paragraphTextById.has(paragraphId))) {
    return sourceIndexFailure('planned_paragraph_source_missing');
  }
  return { ok: true, paragraphTextById };
}

export function segmentsOverlap(left: LabeledSegment, right: LabeledSegment): boolean {
  return (
    left.paragraphId === right.paragraphId && left.startOffset < right.endOffset && right.startOffset < left.endOffset
  );
}

export function validateNativeLabelSegmentAnchors(
  segments: readonly LabeledSegment[],
  input: {
    readonly novelId: string;
    readonly chapterId: string;
    readonly paragraphTextById: ReadonlyMap<string, string>;
    readonly requiredParagraphIds?: readonly string[];
    readonly reasonPrefix: 'generated' | 'canonical';
  },
): string | undefined {
  const reason = (suffix: string) => `${input.reasonPrefix}_${suffix}`;
  if (segments.length === 0) return reason('segments_empty');

  const byParagraph = new Map<string, LabeledSegment[]>();
  for (const segment of segments) {
    const paragraphText = input.paragraphTextById.get(segment.paragraphId);
    if (segment.novelId !== input.novelId || segment.chapterId !== input.chapterId || paragraphText === undefined) {
      return reason('segment_source_missing');
    }
    if (
      !Number.isSafeInteger(segment.startOffset) ||
      !Number.isSafeInteger(segment.endOffset) ||
      segment.startOffset < 0 ||
      segment.endOffset <= segment.startOffset ||
      segment.endOffset > paragraphText.length
    ) {
      return reason('segment_offsets_invalid');
    }
    if (!matchesIntegrityHash(segment.segmentTextHash, paragraphText.slice(segment.startOffset, segment.endOffset))) {
      return reason('segment_text_hash_mismatch');
    }
    const group = byParagraph.get(segment.paragraphId) ?? [];
    group.push(segment);
    byParagraph.set(segment.paragraphId, group);
  }

  for (const group of byParagraph.values()) {
    const sorted = [...group].sort(
      (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      if (segmentsOverlap(sorted[index - 1]!, sorted[index]!)) return reason('segments_overlap');
    }
  }

  if (input.requiredParagraphIds?.some((paragraphId) => !byParagraph.has(paragraphId))) {
    return reason('segment_coverage_incomplete');
  }
  return undefined;
}

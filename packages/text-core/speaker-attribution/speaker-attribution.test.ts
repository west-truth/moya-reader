import { describe, expect, it } from 'vitest';
import { textIntegrityHash } from '../hash';
import { buildSpanBoundaryPatch, applySpanBoundaryPatch } from './boundary-patch';
import { buildDialogueBurstInventory } from './dialogue-burst';
import { buildSpeakerSceneInventory } from './scene-inventory';
import { buildSpeakerSourceManifest } from './source-manifest';
import { assertSpeakerSpanInventory, buildSpeakerSpanInventory } from './span-inventory';
import type { SpeakerSourceParagraphInput } from './contracts';

function paragraphs(chapterId: string, texts: readonly string[]): SpeakerSourceParagraphInput[] {
  let offset = 0;
  return texts.map((text, paragraphIndex) => {
    const startOffsetInChapter = offset;
    const endOffsetInChapter = startOffsetInChapter + text.length;
    offset = endOffsetInChapter + 2;
    return {
      paragraphId: `paragraph_${paragraphIndex}`,
      chapterId,
      paragraphIndex,
      text,
      textHash: textIntegrityHash(text),
      startOffsetInChapter,
      endOffsetInChapter,
    };
  });
}

describe('speaker source and span inventory', () => {
  it('turns a 73-vs-90 chapter hint into review instead of silent success', () => {
    const chapterTexts = Array.from({ length: 73 }, (_, index) => `chapter body ${index + 1}`);
    const normalizedText = chapterTexts.join('');
    let sourceOffset = 0;
    const chapters = chapterTexts.map((text, index) => {
      const sourceStartOffset = sourceOffset;
      const sourceEndOffset = sourceStartOffset + text.length;
      sourceOffset = sourceEndOffset;
      return {
        chapterId: `chapter_${index + 1}`,
        chapterIndex: index + 1,
        sourceStartOffset,
        sourceEndOffset,
        bodyStartOffset: sourceStartOffset,
        bodyEndOffset: sourceEndOffset,
        text,
        textHash: textIntegrityHash(text),
        paragraphCount: 1,
      };
    });

    const manifest = buildSpeakerSourceManifest({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      activeContentRevisionId: 'revision_1',
      sourceHash: 'sha256:source',
      normalizedText,
      normalizedTextHash: textIntegrityHash(normalizedText),
      expectedChapterCount: 90,
      chapters,
    });

    expect(manifest.status).toBe('review_required');
    expect(manifest.acceptedChapterCount).toBe(73);
    expect(manifest.issues).toEqual([
      expect.objectContaining({ code: 'expected_chapter_count_mismatch', severity: 'review' }),
    ]);
  });

  it('preserves mixed, nested, and unbalanced paragraphs with exact UTF-16 coverage', () => {
    const sourceParagraphs = paragraphs('chapter_1', [
      '“안녕.”',
      '그가 말했다. “왔어?” 그녀가 답했다. “응.”',
      '“끝나지 않은 대사',
      '「그가 『안녕』이라고 말했다」',
      '조용한 복도였다.',
    ]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs: sourceParagraphs,
    });
    const inventory = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs: sourceParagraphs,
      sceneInventory: scenes,
    });

    expect(() => assertSpeakerSpanInventory(inventory, sourceParagraphs)).not.toThrow();
    expect(inventory.spans.filter((span) => span.paragraphId === 'paragraph_0')).toEqual([
      expect.objectContaining({ type: 'dialogue', startOffset: 0, endOffset: 5, boundaryReview: false }),
    ]);
    expect(inventory.spans.find((span) => span.paragraphId === 'paragraph_2')).toMatchObject({
      type: 'unknown',
      boundaryReview: true,
      startOffset: 0,
      endOffset: sourceParagraphs[2]!.text.length,
    });
    const mixedParagraphSpans = inventory.spans.filter((span) => span.paragraphId === 'paragraph_1');
    expect(mixedParagraphSpans.filter((span) => span.type === 'dialogue')).toHaveLength(2);
    expect(mixedParagraphSpans.every((span) => !span.boundaryReview)).toBe(true);
    expect(
      mixedParagraphSpans
        .filter((span) => span.type === 'dialogue')
        .every((span) => span.boundaryCode === 'balanced_multi_quote'),
    ).toBe(true);
    expect(inventory.boundaryReviewSpanIds).toHaveLength(2);

    const repeated = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs: sourceParagraphs,
      sceneInventory: scenes,
    });
    expect(repeated.fingerprint).toBe(inventory.fingerprint);
  });

  it('builds deterministic two- and three-participant dialogue bursts', () => {
    const sourceParagraphs = paragraphs('chapter_1', [
      'Alex: One.',
      'Blair: Two.',
      'The room became quiet.',
      'Alex: Three.',
      'Blair: Four.',
      'Casey: Five.',
    ]);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs: sourceParagraphs,
    });
    const spans = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs: sourceParagraphs,
      sceneInventory: scenes,
    });
    const byParagraph = new Map(spans.spans.map((span) => [span.paragraphId, span.id]));
    const participants = {
      [byParagraph.get('paragraph_0')!]: ['character_alex'],
      [byParagraph.get('paragraph_1')!]: ['character_blair'],
      [byParagraph.get('paragraph_3')!]: ['character_alex'],
      [byParagraph.get('paragraph_4')!]: ['character_blair'],
      [byParagraph.get('paragraph_5')!]: ['character_casey'],
    };
    const bursts = buildDialogueBurstInventory({
      spanInventory: spans,
      participantCandidateIdsBySpan: participants,
    });

    expect(bursts.bursts).toHaveLength(2);
    expect(bursts.bursts[0]).toMatchObject({ alternationMode: 'two_party_soft' });
    expect(bursts.bursts[1]).toMatchObject({ alternationMode: 'multi_party' });
    expect(
      buildDialogueBurstInventory({ spanInventory: spans, participantCandidateIdsBySpan: participants }).fingerprint,
    ).toBe(bursts.fingerprint);
  });

  it('applies a hash-fenced split patch without changing source coverage', () => {
    const sourceParagraphs = paragraphs('chapter_1', ['“안녕. 그가 돌아섰다']);
    const scenes = buildSpeakerSceneInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphs: sourceParagraphs,
    });
    const inventory = buildSpeakerSpanInventory({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphs: sourceParagraphs,
      sceneInventory: scenes,
    });
    const first = inventory.spans[0]!;
    const patch = buildSpanBoundaryPatch({
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      expectedInventoryHash: inventory.fingerprint,
      operations: [
        {
          kind: 'split',
          spanId: first.id,
          splitOffsets: [4],
          resultTypes: ['dialogue', 'narration'],
        },
      ],
      createdBy: 'user',
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const patched = applySpanBoundaryPatch({ inventory, patch, paragraphs: sourceParagraphs });
    expect(patched.spans).toEqual([
      expect.objectContaining({ startOffset: 0, endOffset: 4, type: 'dialogue', boundaryReview: false }),
      expect.objectContaining({ startOffset: 4, endOffset: sourceParagraphs[0]!.text.length, type: 'narration' }),
    ]);
    expect(() => assertSpeakerSpanInventory(patched, sourceParagraphs)).not.toThrow();
  });
});

import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
  SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import { describe, expect, it } from 'vitest';
import type { SourceMentionV1 } from './mention-inventory';
import {
  buildSpeakerContextEnvelope,
  sliceSpeakerContextEnvelope,
  SpeakerContextRoleCode,
} from './speaker-context-envelope';

function paragraph(paragraphIndex: number, text: string): SpeakerSourceParagraphInput {
  return {
    paragraphId: `paragraph_${paragraphIndex}`,
    chapterId: 'chapter_1',
    paragraphIndex,
    text,
    textHash: textIntegrityHash(text),
    startOffsetInChapter: paragraphIndex * 100,
    endOffsetInChapter: paragraphIndex * 100 + text.length,
  };
}

function span(
  id: string,
  paragraphId: string,
  sceneId: string,
  spanIndex: number,
  startOffset: number,
  endOffset: number,
  text: string,
): SpeakerSpanV1 {
  return {
    id,
    bookId: 'book_1',
    contentRevisionId: 'revision_1',
    chapterId: 'chapter_1',
    paragraphId,
    sceneId,
    spanIndex,
    startOffset,
    endOffset,
    textHash: textIntegrityHash(text.slice(startOffset, endOffset)),
    type: 'dialogue',
    voiceBearing: true,
    boundaryReview: false,
    boundaryCode: 'quoted_dialogue',
  };
}

describe('speaker context envelope', () => {
  it('keeps bounded exact source blocks from the target scene and reindexes a target slice', () => {
    const paragraphs = [
      paragraph(0, '민서는 고개를 들었다.'),
      paragraph(1, '그가 말했다. “안녕.” 그리고 웃었다.'),
      paragraph(2, '현우는 잠시 대답하지 못했다.'),
      paragraph(3, '미래 장면의 인물은 아직 등장하지 않았다.'),
    ];
    const firstStart = paragraphs[1]!.text.indexOf('“');
    const firstEnd = paragraphs[1]!.text.indexOf('”') + 1;
    const secondStart = 0;
    const secondEnd = paragraphs[2]!.text.length;
    const targets = [
      span('span_1', paragraphs[1]!.paragraphId, 'scene_1', 1, firstStart, firstEnd, paragraphs[1]!.text),
      span('span_2', paragraphs[2]!.paragraphId, 'scene_1', 2, secondStart, secondEnd, paragraphs[2]!.text),
    ];
    const priorContext = span(
      'span_context',
      paragraphs[0]!.paragraphId,
      'scene_1',
      0,
      0,
      paragraphs[0]!.text.length,
      paragraphs[0]!.text,
    );
    const future = span(
      'span_future',
      paragraphs[3]!.paragraphId,
      'scene_2',
      3,
      0,
      paragraphs[3]!.text.length,
      paragraphs[3]!.text,
    );
    const spanInventory: SpeakerSpanInventoryV1 = {
      version: 'speaker-span-inventory-v1',
      id: 'inventory_1',
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      detectorVersion: 'fixture',
      spans: [priorContext, ...targets, future],
      boundaryReviewSpanIds: [],
      fingerprint: 'inventory_hash',
    };

    const envelope = buildSpeakerContextEnvelope({
      sceneId: 'scene_1',
      targets,
      spanInventory,
      paragraphs,
    });
    const text = envelope.blocks.map((block) => block[7]).join('\n');
    expect(text).toContain('그가 말했다. ');
    expect(text).toContain(' 그리고 웃었다.');
    expect(text).toContain('민서는 고개를 들었다.');
    expect(text).not.toContain('미래 장면');
    expect(envelope.targets[0]![1].map(([roleCode]) => roleCode)).toEqual([
      SpeakerContextRoleCode.sameParagraphBefore,
      SpeakerContextRoleCode.sameParagraphAfter,
      SpeakerContextRoleCode.previousParagraph,
      SpeakerContextRoleCode.nextParagraph,
    ]);

    const sliced = sliceSpeakerContextEnvelope(envelope, [1]);
    expect(sliced.targets).toHaveLength(1);
    expect(sliced.targets[0]![0]).toBe(0);
    expect(sliced.blocks.every(([ordinal]) => ordinal >= 0 && ordinal < sliced.blocks.length)).toBe(true);
    expect(sliced.fingerprint).not.toBe(envelope.fingerprint);
  });

  it('includes a bounded second paragraph on both sides without crossing the scene', () => {
    const paragraphs = [
      paragraph(0, 'second previous attribution'),
      paragraph(1, 'previous dialogue'),
      paragraph(2, 'target dialogue'),
      paragraph(3, 'next dialogue'),
      paragraph(4, 'second next attribution'),
      paragraph(5, 'different scene text'),
    ];
    const target = span('target', 'paragraph_2', 'scene_1', 2, 0, paragraphs[2]!.text.length, paragraphs[2]!.text);
    const contextSpans = [0, 1, 3, 4].map((paragraphIndex) =>
      span(
        `context_${paragraphIndex}`,
        `paragraph_${paragraphIndex}`,
        'scene_1',
        paragraphIndex,
        0,
        paragraphs[paragraphIndex]!.text.length,
        paragraphs[paragraphIndex]!.text,
      ),
    );
    const outside = span('outside', 'paragraph_5', 'scene_2', 5, 0, paragraphs[5]!.text.length, paragraphs[5]!.text);
    const spanInventory: SpeakerSpanInventoryV1 = {
      version: 'speaker-span-inventory-v1',
      id: 'inventory_2',
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      detectorVersion: 'fixture',
      spans: [...contextSpans, target, outside],
      boundaryReviewSpanIds: [],
      fingerprint: 'inventory_hash_2',
    };

    const envelope = buildSpeakerContextEnvelope({
      sceneId: 'scene_1',
      targets: [target],
      spanInventory,
      paragraphs,
    });

    expect(envelope.targets[0]![1].map(([roleCode]) => roleCode)).toEqual([
      SpeakerContextRoleCode.previousParagraph,
      SpeakerContextRoleCode.nextParagraph,
      SpeakerContextRoleCode.secondPreviousParagraph,
      SpeakerContextRoleCode.secondNextParagraph,
    ]);
    const text = envelope.blocks.map((block) => block[7]).join('\n');
    expect(text).toContain('second previous attribution');
    expect(text).toContain('second next attribution');
    expect(text).not.toContain('different scene text');
  });

  it('adds only the exact earlier span for a bounded distant candidate source', () => {
    const paragraphs = [
      paragraph(0, '김민준에게 준비를 부탁했다.'),
      ...Array.from({ length: 13 }, (_, index) => paragraph(index + 1, `중간 서술 ${index}`)),
      paragraph(14, '“준비됐습니다.”'),
    ];
    const spans = paragraphs.map((source, index) =>
      span(`span_${index}`, source.paragraphId, 'scene_1', index, 0, source.text.length, source.text),
    );
    const spanInventory: SpeakerSpanInventoryV1 = {
      version: 'speaker-span-inventory-v1',
      id: 'inventory_distant_source',
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      detectorVersion: 'fixture',
      spans,
      boundaryReviewSpanIds: [],
      fingerprint: 'inventory_distant_source_hash',
    };
    const supportingMention: SourceMentionV1 = {
      id: 'mention_minjun',
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_0',
      paragraphIndex: 0,
      ordinal: 0,
      sceneId: 'scene_1',
      spanId: 'span_0',
      spanIndex: 0,
      startOffset: 0,
      endOffset: 3,
      surfaceHash: textIntegrityHash('김민준'),
      normalizedSurface: '김민준',
      type: 'name',
      extractionCode: 'known_character_surface',
      characterId: 'character_minjun',
    };
    const target = spans.at(-1)!;

    const envelope = buildSpeakerContextEnvelope({
      sceneId: 'scene_1',
      targets: [target],
      spanInventory,
      paragraphs,
      supportingMentionsByTargetSpanId: { [target.id]: [supportingMention] },
    });
    const distantReference = envelope.targets[0]![1].find(
      ([roleCode]) => roleCode === SpeakerContextRoleCode.distantCandidateSource,
    );
    const distantBlock = envelope.blocks.find(([ordinal]) => ordinal === distantReference?.[1]);

    expect(distantBlock?.[7]).toBe(paragraphs[0]!.text);
    expect(distantBlock?.[6]).toBe(textIntegrityHash(paragraphs[0]!.text));
  });

  it('caps a long distant source block while retaining the grounded mention', () => {
    const prefix = '서술'.repeat(200);
    const sourceText = `${prefix}김민준${'후속'.repeat(200)}`;
    const paragraphs = [
      paragraph(0, sourceText),
      ...Array.from({ length: 13 }, (_, index) => paragraph(index + 1, `중간 서술 ${index}`)),
      paragraph(14, '“준비됐습니다.”'),
    ];
    const spans = paragraphs.map((source, index) =>
      span(`span_${index}`, source.paragraphId, 'scene_1', index, 0, source.text.length, source.text),
    );
    const spanInventory: SpeakerSpanInventoryV1 = {
      version: 'speaker-span-inventory-v1',
      id: 'inventory_long_distant_source',
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      detectorVersion: 'fixture',
      spans,
      boundaryReviewSpanIds: [],
      fingerprint: 'inventory_long_distant_source_hash',
    };
    const target = spans.at(-1)!;
    const mentionStart = prefix.length;
    const supportingMention: SourceMentionV1 = {
      id: 'mention_minjun_long',
      bookId: 'book_1',
      contentRevisionId: 'revision_1',
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_0',
      paragraphIndex: 0,
      ordinal: 0,
      sceneId: 'scene_1',
      spanId: 'span_0',
      spanIndex: 0,
      startOffset: mentionStart,
      endOffset: mentionStart + '김민준'.length,
      surfaceHash: textIntegrityHash('김민준'),
      normalizedSurface: '김민준',
      type: 'name',
      extractionCode: 'known_character_surface',
      characterId: 'character_minjun',
    };

    const envelope = buildSpeakerContextEnvelope({
      sceneId: 'scene_1',
      targets: [target],
      spanInventory,
      paragraphs,
      supportingMentionsByTargetSpanId: { [target.id]: [supportingMention] },
    });
    const distantReference = envelope.targets[0]![1].find(
      ([roleCode]) => roleCode === SpeakerContextRoleCode.distantCandidateSource,
    );
    const distantBlock = envelope.blocks.find(([ordinal]) => ordinal === distantReference?.[1]);

    expect(distantBlock?.[7]).toContain('김민준');
    expect(distantBlock?.[7]).toHaveLength(480);
    expect(distantBlock?.[6]).toBe(textIntegrityHash(distantBlock![7]));
  });
});

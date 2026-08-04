import { structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import type { Chapter, Character, Paragraph } from '../../domain/types';
import { backfillCharacterGraphKnowledgeV2 } from '../character-graph-v2';
import { describe, expect, it } from 'vitest';
import {
  materializeSpeakerAttributionInput,
  prepareSpeakerAttributionInputMaterialization,
  type SpeakerAttributionInputMaterializerSource,
} from './input-materializer';

const bookId = 'book_1';
const chapterId = 'chapter_1';
const contentRevisionId = 'content_revision_1';
const createdAt = '2026-07-13T00:00:00.000Z';

const characters: Character[] = [
  {
    id: 'character_alex',
    novelId: bookId,
    canonicalName: 'Alex',
    aliases: [],
    color: '#335577',
    confidence: 1,
    isUserConfirmed: true,
  },
  {
    id: 'character_blair',
    novelId: bookId,
    canonicalName: 'Blair',
    aliases: [],
    color: '#775533',
    confidence: 1,
    isUserConfirmed: true,
  },
];

function paragraphs(texts: readonly string[]): Paragraph[] {
  let offset = 0;
  return texts.map((text, index) => {
    const startOffsetInChapter = offset;
    offset += text.length + 2;
    return {
      id: `paragraph_${index}`,
      novelId: bookId,
      chapterId,
      index,
      text,
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
      textHash: textIntegrityHash(text),
    };
  });
}

function chapter(source: readonly Paragraph[]): Chapter {
  const normalizedText = source.map((item) => item.text).join('\n\n');
  return {
    id: chapterId,
    novelId: bookId,
    index: 7,
    title: 'Chapter 7',
    normalizedText,
    textHash: textIntegrityHash(normalizedText),
    rawStartOffset: 0,
    rawEndOffset: normalizedText.length,
    characterCount: normalizedText.length,
    paragraphCount: source.length,
    createdAt,
    updatedAt: createdAt,
  };
}

function source(
  allChapterParagraphs: readonly Paragraph[],
  targetParagraphs: readonly Paragraph[],
  providerOptions: Readonly<Record<string, unknown>> = {},
): SpeakerAttributionInputMaterializerSource {
  const graph = { novelId: bookId, characters, relations: [] };
  return {
    bookId,
    contentRevisionId,
    normalizedTextHash: 'normalized_hash_1',
    graphRevision: 'graph_revision_1',
    correctionCursor: 'correction_cursor_1',
    chapter: chapter(allChapterParagraphs),
    paragraphs: targetParagraphs,
    allChapterParagraphs,
    characters,
    graphKnowledge: backfillCharacterGraphKnowledgeV2(graph),
    userCorrections: [],
    providerId: 'mock',
    modelId: 'mock-speaker-v1',
    providerOptions: {
      maxSpeakerTargets: 40,
      modelMaxOutputTokens: 8_192,
      ...providerOptions,
    },
    coversFullChapter: targetParagraphs.length === allChapterParagraphs.length,
    finalWindowForChapter: targetParagraphs.at(-1)?.id === allChapterParagraphs.at(-1)?.id,
  };
}

function materialize(input: SpeakerAttributionInputMaterializerSource) {
  const prepared = prepareSpeakerAttributionInputMaterialization(input, []);
  return {
    prepared,
    materialized: materializeSpeakerAttributionInput(prepared, {
      addressEvents: [],
      temporalRelationEdges: [],
    }),
  };
}

describe('speaker attribution input materializer', () => {
  it('builds deterministic pinned input with the full text-free chapter burst inventory', () => {
    const all = paragraphs(['"First scene."', '***', '"Second scene."']);
    const input = source(all, [all[0]!]);

    const first = materialize(input);
    const second = materialize(input);
    const burstInventory = first.materialized.payload.canonicalSource.dialogueBurstInventory;

    expect(first.materialized).toEqual(second.materialized);
    expect(first.materialized.payload.sourceManifestFingerprint).toBe(
      structuredIntegrityHash({ contentRevisionId, normalizedTextHash: input.normalizedTextHash }),
    );
    expect(burstInventory).toEqual(first.prepared.chapterBuild.inventory.dialogueBurstInventory);
    expect(burstInventory?.bursts).toHaveLength(2);
    expect(burstInventory?.bursts.flatMap((burst) => burst.targetSpanIndexes)).toEqual([0, 2]);
    expect(burstInventory?.bursts.every((burst) => !Object.prototype.hasOwnProperty.call(burst, 'text'))).toBe(true);
    expect(JSON.stringify(burstInventory)).not.toContain('First scene.');
    expect(JSON.stringify(burstInventory)).not.toContain('Second scene.');

    expect(first.materialized.payload.units).toHaveLength(1);
    expect(first.materialized.payload.units[0]?.packet.targets.map((target) => target[0])).toEqual([0]);
    expect(first.materialized.payload.dialogueBurstInventoryHash).toBe(burstInventory?.fingerprint);
  });

  it('plans bounded packets without changing target order', () => {
    const all = paragraphs(Array.from({ length: 45 }, (_, index) => `"Dialogue ${index}."`));
    const { materialized } = materialize(source(all, all, { maxSpeakerTargets: 10 }));
    const targetIndexes = materialized.payload.units.flatMap((unit) => unit.packet.targets.map((target) => target[0]));

    expect(materialized.payload.units.length).toBeGreaterThan(1);
    expect(materialized.payload.units.every((unit) => unit.packet.targets.length <= 10)).toBe(true);
    expect(targetIndexes).toEqual(Array.from({ length: 45 }, (_, index) => index));
  });
});

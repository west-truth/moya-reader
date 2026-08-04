import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { Chapter, Character, Paragraph } from '@noveldesk/contracts';
import type { RevisionQueryable } from './analysis-input-repository.js';
import type { BookAIWorkflowLabelingWindow } from '../../../../../src/providers/book-ai-workflow-plan';
import { backfillCharacterGraphKnowledgeV2 } from '../../../../../src/providers/character-graph-v2';
import { routeSpeakerRisks } from '../../../../../src/providers/speaker-attribution/routing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  getSourceManifest: vi.fn(),
  replaceInventory: vi.fn(),
  appendAddressEvents: vi.fn(),
  listAddressEvents: vi.fn(),
  listRelationEdges: vi.fn(),
  replaceSnapshots: vi.fn(),
}));

vi.mock('../speaker-attribution-store.js', () => ({
  getHostedSpeakerSourceManifest: stores.getSourceManifest,
  replaceHostedSpeakerAttributionChapterInventoryInTransaction: stores.replaceInventory,
}));

vi.mock('../temporal-character-memory-service.js', () => ({
  appendHostedTemporalAddressUseEvents: stores.appendAddressEvents,
  listHostedTemporalAddressUseEvents: stores.listAddressEvents,
  listHostedTemporalRelationEdges: stores.listRelationEdges,
  replaceHostedCharacterTemporalSnapshotsInTransaction: stores.replaceSnapshots,
}));

import { materializeHostedSpeakerAttributionInput } from './speaker-attribution-input-materializer.js';

const bookId = 'book_1';
const chapterId = 'chapter_1';
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

function windowFor(source: readonly Paragraph[], sequence: number): BookAIWorkflowLabelingWindow {
  return {
    id: `window_${sequence}`,
    sequence,
    chapterId,
    chapterIndex: 7,
    paragraphIds: source.map((item) => item.id),
    startParagraphIndex: source[0]?.index ?? 0,
    endParagraphIndex: source.at(-1)?.index ?? 0,
    characterCount: source.reduce((total, item) => total + item.text.length, 0),
    textHashFingerprint: textIntegrityHash(source.map((item) => item.textHash).join(':')),
    dependsOnGraph: true,
  };
}

function queryable(): RevisionQueryable {
  return {
    query: vi.fn(async () => ({
      command: 'SELECT',
      rows: [],
      rowCount: 0,
      oid: 0,
      fields: [],
    })) as unknown as RevisionQueryable['query'],
  };
}

async function materialize(input: {
  readonly all: readonly Paragraph[];
  readonly target: readonly Paragraph[];
  readonly sequence?: number;
  readonly maxTargets?: number;
  readonly previousEpisodeContext?: Parameters<
    typeof materializeHostedSpeakerAttributionInput
  >[1]['previousEpisodeContext'];
}) {
  const graph = { novelId: bookId, characters, relations: [] };
  return materializeHostedSpeakerAttributionInput(queryable(), {
    userId: 'user_1',
    bookId,
    contentRevisionId: 'content_revision_1',
    normalizedTextHash: 'normalized_hash_1',
    graphRevision: 'graph_revision_1',
    correctionCursor: 'correction_cursor_1',
    chapter: chapter(input.all),
    paragraphs: input.target,
    allChapterParagraphs: input.all,
    graph,
    graphKnowledge: backfillCharacterGraphKnowledgeV2(graph),
    previousEpisodeContext: input.previousEpisodeContext,
    userCorrections: [],
    window: windowFor(input.target, input.sequence ?? 0),
    providerId: 'mock',
    modelId: 'mock-speaker-v1',
    providerOptions: {
      maxSpeakerTargets: input.maxTargets ?? 40,
      modelMaxOutputTokens: 8_192,
    },
    coversFullChapter: input.target.length === input.all.length,
    finalWindowForChapter: input.target.at(-1)?.id === input.all.at(-1)?.id,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stores.getSourceManifest.mockResolvedValue(undefined);
  stores.replaceInventory.mockResolvedValue(undefined);
  stores.appendAddressEvents.mockResolvedValue(undefined);
  stores.listAddressEvents.mockResolvedValue([]);
  stores.listRelationEdges.mockResolvedValue([]);
  stores.replaceSnapshots.mockResolvedValue(undefined);
});

describe('hosted compact speaker input materialization', () => {
  it('keeps chapter-relative inventories stable while scoping packets and risk to the current window', async () => {
    const all = paragraphs(['"First line."', '"Unbalanced future line', '"Last line."']);
    const previousEpisodeContext = {
      chapterId: 'chapter_0',
      summary: 'Alex was speaking.',
      activeCharacterIds: ['character_alex'],
      unresolved: [],
      recentTurns: [
        {
          paragraphId: 'previous_paragraph',
          speakerId: 'character_alex',
          listenerIds: ['character_blair'],
          emotion: 'neutral',
          text: 'Remember this turn.',
        },
      ],
    };

    const first = await materialize({ all, target: [all[0]!], previousEpisodeContext });
    const last = await materialize({ all, target: [all[2]!], sequence: 1, previousEpisodeContext });

    expect(first.spanInventoryHash).toBe(last.spanInventoryHash);
    expect(
      first.canonicalSource.spanInventory.spans.map(({ id, spanIndex, sceneId }) => ({ id, spanIndex, sceneId })),
    ).toEqual(
      last.canonicalSource.spanInventory.spans.map(({ id, spanIndex, sceneId }) => ({ id, spanIndex, sceneId })),
    );
    expect(stores.replaceInventory).toHaveBeenCalledTimes(2);
    expect(stores.replaceInventory.mock.calls[0]?.[2].fingerprint).toBe(
      stores.replaceInventory.mock.calls[1]?.[2].fingerprint,
    );

    const paragraphIdBySpanIndex = new Map(
      first.canonicalSource.spanInventory.spans.map((span) => [span.spanIndex, span.paragraphId]),
    );
    expect(
      first.units.flatMap((unit) => unit.packet.targets).map((target) => paragraphIdBySpanIndex.get(target[0])),
    ).toEqual([all[0]!.id]);
    expect(
      last.units.flatMap((unit) => unit.packet.targets).map((target) => paragraphIdBySpanIndex.get(target[0])),
    ).toEqual([all[2]!.id]);
    expect(first.units.flatMap((unit) => unit.packet.recentTurns).map((turn) => turn[1])).toContain(
      'Remember this turn.',
    );

    const currentSpanIndexes = first.canonicalSource.spanInventory.spans
      .filter((span) => span.paragraphId === all[0]!.id)
      .map((span) => span.spanIndex);
    expect(first.canonicalSource.sieve.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'boundary_review', spanIndex: 1 })]),
    );
    expect(
      routeSpeakerRisks({
        sieve: first.canonicalSource.sieve,
        attributedUnits: [],
        sequenceDecisions: [],
        targetSpanIndexes: currentSpanIndexes,
      }),
    ).toEqual([]);
  });

  it('splits a long same-scene target set into bounded packets without changing target order', async () => {
    const all = paragraphs(Array.from({ length: 45 }, (_, index) => `"Dialogue ${index}."`));
    const result = await materialize({ all, target: all, maxTargets: 10 });
    const targetIndexes = result.units.flatMap((unit) => unit.packet.targets.map((target) => target[0]));

    expect(result.units.length).toBeGreaterThan(1);
    expect(new Set(result.units.map((unit) => unit.sceneId))).toHaveLength(1);
    expect(result.units.every((unit) => unit.packet.targets.length <= 10)).toBe(true);
    expect(targetIndexes).toHaveLength(45);
    expect(targetIndexes).toEqual([...targetIndexes].sort((left, right) => left - right));
    expect(new Set(targetIndexes).size).toBe(45);
  });

  it('covers a multi-scene window exactly once with scene-local packet planning', async () => {
    const all = paragraphs(['"First scene."', '***', '"Second scene."']);
    const result = await materialize({ all, target: all });
    const targetIndexes = result.units.flatMap((unit) => unit.packet.targets.map((target) => target[0]));

    expect(new Set(result.units.map((unit) => unit.sceneId))).toHaveLength(2);
    expect(targetIndexes).toHaveLength(2);
    expect(targetIndexes).toEqual([...targetIndexes].sort((left, right) => left - right));
    expect(new Set(targetIndexes)).toHaveLength(2);
  });
});

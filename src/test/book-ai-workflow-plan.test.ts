import { describe, expect, it } from 'vitest';
import type { Chapter, Paragraph } from '../domain/types';
import { planBookAIWorkflow } from '../providers/book-ai-workflow-plan';
import { resolveLabelingContextCapability } from '../providers/labeling-context-packet';

function chapter(index: number, characterCount: number, patch: Partial<Chapter> = {}): Chapter {
  return {
    id: `chapter_${index}`,
    novelId: 'book_1',
    index,
    title: `Chapter ${index}`,
    normalizedText: '',
    textHash: `hash_${index}`,
    rawStartOffset: 0,
    rawEndOffset: characterCount,
    characterCount,
    paragraphCount: 0,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...patch,
  };
}

function paragraph(chapterId: string, index: number, length: number): Paragraph {
  return {
    id: `${chapterId}_p_${index}`,
    novelId: 'book_1',
    chapterId,
    index,
    text: 'x'.repeat(length),
    startOffsetInChapter: index * length,
    endOffsetInChapter: (index + 1) * length,
    textHash: `${chapterId}_p_hash_${index}`,
  };
}

describe('planBookAIWorkflow', () => {
  it('groups graph bootstrap bundles by target character budget', () => {
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [chapter(1, 10_000), chapter(2, 20_000), chapter(3, 15_000), chapter(4, 30_000)],
      options: { targetBundleCharacters: 40_000, maxBundleChapters: 5 },
    });

    expect(plan.bundleWindows.map((window) => window.chapterIds)).toEqual([
      ['chapter_1', 'chapter_2'],
      ['chapter_3'],
      ['chapter_4'],
    ]);
    expect(plan.stages.map((stage) => stage.id)).toEqual([
      'character_graph_bootstrap',
      'character_graph_merge',
      'chapter_labeling',
      'tts_ready_preparation',
    ]);
    expect(plan.stages[1]).toEqual({
      id: 'character_graph_merge',
      dependsOn: 'character_graph_bootstrap',
      itemIds: ['character_graph_merge'],
    });
    expect(plan.stages[2].dependsOn).toBe('character_graph_merge');
  });

  it('enforces the maximum number of chapters per graph bundle', () => {
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [chapter(1, 1_000), chapter(2, 1_000), chapter(3, 1_000), chapter(4, 1_000)],
      options: { targetBundleCharacters: 100_000, maxBundleChapters: 2 },
    });

    expect(plan.bundleWindows.map((window) => window.chapterIds)).toEqual([
      ['chapter_1', 'chapter_2'],
      ['chapter_3', 'chapter_4'],
    ]);
  });

  it('keeps an oversized chapter as its own graph bundle', () => {
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [chapter(1, 5_000), chapter(2, 80_000), chapter(3, 5_000)],
      options: { targetBundleCharacters: 50_000, maxBundleChapters: 5 },
    });

    expect(plan.bundleWindows.map((window) => window.chapterIds)).toEqual([
      ['chapter_1'],
      ['chapter_2'],
      ['chapter_3'],
    ]);
    expect(plan.bundleWindows[1].characterCount).toBe(80_000);
  });

  it('splits large chapters into paragraph labeling windows', () => {
    const sourceChapter = chapter(1, 30_000, { paragraphCount: 6 });
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [sourceChapter],
      paragraphs: [
        paragraph(sourceChapter.id, 0, 4_000),
        paragraph(sourceChapter.id, 1, 4_000),
        paragraph(sourceChapter.id, 2, 4_000),
        paragraph(sourceChapter.id, 3, 4_000),
        paragraph(sourceChapter.id, 4, 4_000),
        paragraph(sourceChapter.id, 5, 4_000),
      ],
      options: { targetLabelingCharacters: 10_000, maxLabelingParagraphs: 10 },
    });

    expect(plan.labelingChapters).toHaveLength(1);
    expect(plan.labelingWindows.map((window) => window.paragraphIds)).toEqual([
      ['chapter_1_p_0', 'chapter_1_p_1'],
      ['chapter_1_p_2', 'chapter_1_p_3'],
      ['chapter_1_p_4', 'chapter_1_p_5'],
    ]);
    expect(plan.labelingWindows.every((window) => window.dependsOnGraph)).toBe(true);
  });

  it('splits labeling windows by paragraph count even when text is short', () => {
    const sourceChapter = chapter(1, 600, { paragraphCount: 6 });
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [sourceChapter],
      paragraphs: Array.from({ length: 6 }, (_, index) => paragraph(sourceChapter.id, index, 100)),
      options: { targetLabelingCharacters: 10_000, maxLabelingParagraphs: 3 },
    });

    expect(plan.labelingWindows.map((window) => [window.startParagraphIndex, window.endParagraphIndex])).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  it('reduces labeling windows for a small model context before jobs are created', () => {
    const sourceChapter = chapter(1, 1_200, { paragraphCount: 6 });
    const capability = resolveLabelingContextCapability({
      providerId: 'small-provider',
      modelId: 'small-model',
      providerOptions: {
        contextWindowTokens: 4_096,
        maxOutputTokens: 2_048,
        contextSafetyFactor: 0.8,
      },
    });
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [sourceChapter],
      paragraphs: Array.from({ length: 6 }, (_, index) => paragraph(sourceChapter.id, index, 200)),
      options: { targetLabelingCharacters: 10_000, maxLabelingParagraphs: 10 },
      labelingCapability: capability,
    });

    expect(plan.labelingBudget).toEqual({
      strategy: 'model_aware_estimate',
      targetLabelingCharacters: 256,
      capability,
    });
    expect(plan.labelingWindows.map((window) => window.paragraphIds)).toEqual(
      Array.from({ length: 6 }, (_, index) => [`chapter_1_p_${index}`]),
    );
  });

  it('falls back to one chapter-level labeling window when paragraph details are unavailable', () => {
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [chapter(2, 12_000, { paragraphCount: 100 })],
    });

    expect(plan.labelingWindows).toEqual([
      expect.objectContaining({
        chapterId: 'chapter_2',
        paragraphIds: [],
        startParagraphIndex: 0,
        endParagraphIndex: 99,
        characterCount: 12_000,
        dependsOnGraph: true,
      }),
    ]);
    expect(plan.ttsReady.dependsOnLabelingWindowIds).toEqual([plan.labelingWindows[0].id]);
  });

  it('sorts chapter input before building staged workflow plans', () => {
    const plan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [chapter(3, 1_000), chapter(1, 1_000), chapter(2, 1_000)],
      options: { maxBundleChapters: 2 },
    });

    expect(plan.bundleWindows.map((window) => window.chapterIds)).toEqual([['chapter_1', 'chapter_2'], ['chapter_3']]);
    expect(plan.ttsReady.chapterIds).toEqual(['chapter_1', 'chapter_2', 'chapter_3']);
  });
});

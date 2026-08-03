import type { Chapter, Paragraph } from '../domain/types';
import { bookAIBundleId, bookAILabelWindowId, workflowSourceFingerprint } from '../domain/identity/workflow-identities';
import { recommendedTargetLabelingCharacters, type LabelingContextCapabilitySnapshot } from './labeling-context-packet';

export type BookAIWorkflowStageId =
  'character_graph_bootstrap' | 'character_graph_merge' | 'chapter_labeling' | 'tts_ready_preparation';

export const BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID = 'character_graph_merge';

export interface BookAIWorkflowPlanOptions {
  readonly maxBundleChapters?: number;
  readonly targetBundleCharacters?: number;
  readonly maxLabelingParagraphs?: number;
  readonly targetLabelingCharacters?: number;
}

export type BookAIWorkflowChapterSource = Pick<
  Chapter,
  'id' | 'index' | 'title' | 'characterCount' | 'paragraphCount' | 'textHash'
>;

export type BookAIWorkflowParagraphSource = Pick<Paragraph, 'id' | 'chapterId' | 'index' | 'textHash'> & {
  readonly text?: string;
  readonly length?: number;
};

export interface BookAIWorkflowPlanInput {
  readonly novelId: string;
  readonly chapters: readonly BookAIWorkflowChapterSource[];
  readonly paragraphs?: readonly BookAIWorkflowParagraphSource[];
  readonly options?: BookAIWorkflowPlanOptions;
  readonly labelingCapability?: LabelingContextCapabilitySnapshot;
}

export interface BookAIWorkflowBundleWindow {
  readonly id: string;
  readonly bundleId: string;
  readonly sequence: number;
  readonly chapterIds: string[];
  readonly startChapterIndex: number;
  readonly endChapterIndex: number;
  readonly characterCount: number;
  readonly textHashFingerprint: string;
  readonly previousBundleId?: string;
}

export interface BookAIWorkflowLabelingWindow {
  readonly id: string;
  readonly sequence: number;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly paragraphIds: string[];
  readonly startParagraphIndex: number;
  readonly endParagraphIndex: number;
  readonly characterCount: number;
  readonly textHashFingerprint: string;
  readonly dependsOnGraph: true;
}

export interface BookAIWorkflowChapterLabelingPlan {
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly textHash: string;
  readonly dependsOnGraph: true;
  readonly windows: BookAIWorkflowLabelingWindow[];
}

export interface BookAIWorkflowStagePlan {
  readonly id: BookAIWorkflowStageId;
  readonly dependsOn?: BookAIWorkflowStageId;
  readonly itemIds: string[];
}

export interface BookAIWorkflowTTSReadyPlan {
  readonly chapterIds: string[];
  readonly dependsOnLabelingWindowIds: string[];
}

export interface BookAIWorkflowPlan {
  readonly novelId: string;
  readonly totalChapters: number;
  readonly totalCharacters: number;
  readonly stages: BookAIWorkflowStagePlan[];
  readonly bundleWindows: BookAIWorkflowBundleWindow[];
  readonly labelingChapters: BookAIWorkflowChapterLabelingPlan[];
  readonly labelingWindows: BookAIWorkflowLabelingWindow[];
  readonly ttsReady: BookAIWorkflowTTSReadyPlan;
  readonly labelingBudget?: {
    readonly strategy: 'model_aware_estimate';
    readonly targetLabelingCharacters: number;
    readonly capability: LabelingContextCapabilitySnapshot;
  };
}

const DEFAULT_MAX_BUNDLE_CHAPTERS = 5;
const DEFAULT_TARGET_BUNDLE_CHARACTERS = 50_000;
const DEFAULT_MAX_LABELING_PARAGRAPHS = 80;
const DEFAULT_TARGET_LABELING_CHARACTERS = 12_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function fingerprint(parts: readonly string[]): string {
  return workflowSourceFingerprint(parts);
}

function paragraphCharacterCount(paragraph: BookAIWorkflowParagraphSource): number {
  if (typeof paragraph.length === 'number' && Number.isFinite(paragraph.length) && paragraph.length >= 0) {
    return paragraph.length;
  }
  return paragraph.text?.length ?? 0;
}

function sortedChapters(chapters: readonly BookAIWorkflowChapterSource[]): BookAIWorkflowChapterSource[] {
  return [...chapters].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
}

function paragraphsByChapter(
  paragraphs: readonly BookAIWorkflowParagraphSource[] | undefined,
): Map<string, BookAIWorkflowParagraphSource[]> {
  const grouped = new Map<string, BookAIWorkflowParagraphSource[]>();
  for (const paragraph of paragraphs ?? []) {
    const items = grouped.get(paragraph.chapterId) ?? [];
    items.push(paragraph);
    grouped.set(paragraph.chapterId, items);
  }
  for (const items of grouped.values()) {
    items.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  }
  return grouped;
}

function buildBundleWindows(
  novelId: string,
  chapters: readonly BookAIWorkflowChapterSource[],
  options: Required<Pick<BookAIWorkflowPlanOptions, 'maxBundleChapters' | 'targetBundleCharacters'>>,
): BookAIWorkflowBundleWindow[] {
  const windows: BookAIWorkflowBundleWindow[] = [];
  let current: BookAIWorkflowChapterSource[] = [];
  let currentCharacters = 0;

  const flush = () => {
    if (current.length === 0) return;
    const sequence = windows.length;
    const first = current[0];
    const last = current[current.length - 1];
    const textHashFingerprint = fingerprint(current.map((chapter) => `${chapter.id}:${chapter.textHash}`));
    const bundleId = bookAIBundleId({
      novelId,
      startChapterIndex: first.index,
      endChapterIndex: last.index,
      sourceFingerprint: textHashFingerprint,
    });
    windows.push({
      id: bundleId,
      bundleId,
      sequence,
      chapterIds: current.map((chapter) => chapter.id),
      startChapterIndex: first.index,
      endChapterIndex: last.index,
      characterCount: currentCharacters,
      textHashFingerprint,
      previousBundleId: windows.at(-1)?.bundleId,
    });
    current = [];
    currentCharacters = 0;
  };

  for (const chapter of chapters) {
    const wouldExceedChapterCount = current.length >= options.maxBundleChapters;
    const wouldExceedCharacters =
      current.length > 0 && currentCharacters + chapter.characterCount > options.targetBundleCharacters;
    if (wouldExceedChapterCount || wouldExceedCharacters) flush();
    current.push(chapter);
    currentCharacters += chapter.characterCount;
  }
  flush();
  return windows;
}

function fallbackChapterLabelingWindow(
  novelId: string,
  chapter: BookAIWorkflowChapterSource,
  sequence: number,
): BookAIWorkflowLabelingWindow {
  const textHashFingerprint = fingerprint([`${chapter.id}:${chapter.textHash}`]);
  return {
    id: bookAILabelWindowId({
      novelId,
      chapterId: chapter.id,
      startParagraphIndex: 'chapter',
      endParagraphIndex: 'chapter',
      sourceFingerprint: textHashFingerprint,
    }),
    sequence,
    chapterId: chapter.id,
    chapterIndex: chapter.index,
    paragraphIds: [],
    startParagraphIndex: 0,
    endParagraphIndex: Math.max(0, chapter.paragraphCount - 1),
    characterCount: chapter.characterCount,
    textHashFingerprint,
    dependsOnGraph: true,
  };
}

function buildLabelingWindowsForChapter(
  novelId: string,
  chapter: BookAIWorkflowChapterSource,
  paragraphs: readonly BookAIWorkflowParagraphSource[],
  startSequence: number,
  options: Required<Pick<BookAIWorkflowPlanOptions, 'maxLabelingParagraphs' | 'targetLabelingCharacters'>>,
): BookAIWorkflowLabelingWindow[] {
  if (paragraphs.length === 0) {
    return [fallbackChapterLabelingWindow(novelId, chapter, startSequence)];
  }

  const windows: BookAIWorkflowLabelingWindow[] = [];
  let current: BookAIWorkflowParagraphSource[] = [];
  let currentCharacters = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    const textHashFingerprint = fingerprint(current.map((paragraph) => `${paragraph.id}:${paragraph.textHash}`));
    windows.push({
      id: bookAILabelWindowId({
        novelId,
        chapterId: chapter.id,
        startParagraphIndex: first.index,
        endParagraphIndex: last.index,
        sourceFingerprint: textHashFingerprint,
      }),
      sequence: startSequence + windows.length,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      paragraphIds: current.map((paragraph) => paragraph.id),
      startParagraphIndex: first.index,
      endParagraphIndex: last.index,
      characterCount: currentCharacters,
      textHashFingerprint,
      dependsOnGraph: true,
    });
    current = [];
    currentCharacters = 0;
  };

  for (const paragraph of paragraphs) {
    const paragraphCharacters = paragraphCharacterCount(paragraph);
    const wouldExceedParagraphCount = current.length >= options.maxLabelingParagraphs;
    const wouldExceedCharacters =
      current.length > 0 && currentCharacters + paragraphCharacters > options.targetLabelingCharacters;
    if (wouldExceedParagraphCount || wouldExceedCharacters) flush();
    current.push(paragraph);
    currentCharacters += paragraphCharacters;
  }
  flush();
  return windows;
}

export function planBookAIWorkflow(input: BookAIWorkflowPlanInput): BookAIWorkflowPlan {
  const chapters = sortedChapters(input.chapters);
  const requestedTargetLabelingCharacters = positiveInteger(
    input.options?.targetLabelingCharacters,
    DEFAULT_TARGET_LABELING_CHARACTERS,
  );
  const options = {
    maxBundleChapters: positiveInteger(input.options?.maxBundleChapters, DEFAULT_MAX_BUNDLE_CHAPTERS),
    targetBundleCharacters: positiveInteger(input.options?.targetBundleCharacters, DEFAULT_TARGET_BUNDLE_CHARACTERS),
    maxLabelingParagraphs: positiveInteger(input.options?.maxLabelingParagraphs, DEFAULT_MAX_LABELING_PARAGRAPHS),
    targetLabelingCharacters: input.labelingCapability
      ? recommendedTargetLabelingCharacters(input.labelingCapability, requestedTargetLabelingCharacters)
      : requestedTargetLabelingCharacters,
  };
  const paragraphMap = paragraphsByChapter(input.paragraphs);
  const bundleWindows = buildBundleWindows(input.novelId, chapters, options);

  const labelingChapters: BookAIWorkflowChapterLabelingPlan[] = [];
  const labelingWindows: BookAIWorkflowLabelingWindow[] = [];
  for (const chapter of chapters) {
    const windows = buildLabelingWindowsForChapter(
      input.novelId,
      chapter,
      paragraphMap.get(chapter.id) ?? [],
      labelingWindows.length,
      options,
    );
    labelingChapters.push({
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      textHash: chapter.textHash,
      dependsOnGraph: true,
      windows,
    });
    labelingWindows.push(...windows);
  }

  const stages: BookAIWorkflowStagePlan[] = [
    {
      id: 'character_graph_bootstrap',
      itemIds: bundleWindows.map((window) => window.id),
    },
    {
      id: 'character_graph_merge',
      dependsOn: 'character_graph_bootstrap',
      itemIds: [BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID],
    },
    {
      id: 'chapter_labeling',
      dependsOn: 'character_graph_merge',
      itemIds: labelingWindows.map((window) => window.id),
    },
    {
      id: 'tts_ready_preparation',
      dependsOn: 'chapter_labeling',
      itemIds: chapters.map((chapter) => chapter.id),
    },
  ];

  return {
    novelId: input.novelId,
    totalChapters: chapters.length,
    totalCharacters: chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0),
    stages,
    bundleWindows,
    labelingChapters,
    labelingWindows,
    ttsReady: {
      chapterIds: chapters.map((chapter) => chapter.id),
      dependsOnLabelingWindowIds: labelingWindows.map((window) => window.id),
    },
    labelingBudget: input.labelingCapability
      ? {
          strategy: 'model_aware_estimate',
          targetLabelingCharacters: options.targetLabelingCharacters,
          capability: input.labelingCapability,
        }
      : undefined,
  };
}

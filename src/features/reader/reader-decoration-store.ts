import type { Character, LabeledSegment, ReaderHighlight } from '../../domain/types';
import type { ActiveTTSPlayback } from '../../providers/tts-playback-session';

export interface ReaderDecorationInput {
  readonly segments: readonly LabeledSegment[];
  readonly characters: readonly Character[];
  readonly highlights: readonly ReaderHighlight[];
  readonly reviewSegmentIds: ReadonlySet<string>;
  readonly correctionTargetId?: string;
  readonly activePlayback?: ActiveTTSPlayback;
}

export interface ReaderParagraphDecoration {
  readonly segments: readonly LabeledSegment[];
  readonly characters: readonly Character[];
  readonly highlights: readonly ReaderHighlight[];
  readonly reviewSegmentIds: ReadonlySet<string>;
  readonly correctionTargetId?: string;
  readonly activeRanges: readonly { start: number; end: number }[];
}

interface StoredDecoration {
  readonly fingerprint: string;
  readonly snapshot: ReaderParagraphDecoration;
}

const EMPTY_IDS = new Set<string>();
const EMPTY_DECORATION: ReaderParagraphDecoration = {
  segments: [],
  characters: [],
  highlights: [],
  reviewSegmentIds: EMPTY_IDS,
  activeRanges: [],
};

function groupedByParagraph<T extends { paragraphId: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.paragraphId);
    if (group) group.push(item);
    else groups.set(item.paragraphId, [item]);
  }
  return groups;
}

function characterFingerprint(characters: readonly Character[]): string {
  return characters
    .map(
      (character) =>
        `${character.id}:${character.canonicalName}:${character.color}:${character.isUserConfirmed ? 1 : 0}`,
    )
    .join('|');
}

function segmentFingerprint(segment: LabeledSegment, needsReview: boolean): string {
  return [
    segment.id,
    segment.type,
    segment.speakerId,
    segment.emotion,
    segment.confidence,
    segment.startOffset,
    segment.endOffset,
    segment.isUserCorrected ? 1 : 0,
    needsReview ? 1 : 0,
  ].join(':');
}

function highlightFingerprint(highlight: ReaderHighlight): string {
  return `${highlight.id}:${highlight.color}:${highlight.quote}:${highlight.updatedAt}`;
}

export class ReaderDecorationStore {
  private readonly listeners = new Map<string, Set<() => void>>();
  private decorations = new Map<string, StoredDecoration>();

  subscribe(paragraphId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(paragraphId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(paragraphId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(paragraphId);
    };
  }

  getSnapshot(paragraphId: string): ReaderParagraphDecoration {
    return this.decorations.get(paragraphId)?.snapshot ?? EMPTY_DECORATION;
  }

  update(input: ReaderDecorationInput): void {
    const segments = groupedByParagraph(input.segments);
    const highlights = groupedByParagraph(input.highlights);
    const paragraphIds = new Set([...this.decorations.keys(), ...segments.keys(), ...highlights.keys()]);
    if (input.activePlayback?.paragraphId) paragraphIds.add(input.activePlayback.paragraphId);

    const next = new Map<string, StoredDecoration>();
    const charactersKey = characterFingerprint(input.characters);
    for (const paragraphId of paragraphIds) {
      const paragraphSegments = segments.get(paragraphId) ?? [];
      const paragraphHighlights = highlights.get(paragraphId) ?? [];
      const reviewIds = new Set(
        paragraphSegments.filter((segment) => input.reviewSegmentIds.has(segment.id)).map((segment) => segment.id),
      );
      const correctionTargetId = paragraphSegments.some((segment) => segment.id === input.correctionTargetId)
        ? input.correctionTargetId
        : undefined;
      const activeRanges = input.activePlayback?.paragraphId === paragraphId ? input.activePlayback.ranges : [];
      const fingerprint = [
        charactersKey,
        paragraphSegments.map((segment) => segmentFingerprint(segment, reviewIds.has(segment.id))).join('|'),
        paragraphHighlights.map(highlightFingerprint).join('|'),
        correctionTargetId ?? '',
        activeRanges.map((range) => `${range.start}:${range.end}`).join('|'),
      ].join('::');
      const previous = this.decorations.get(paragraphId);
      if (previous?.fingerprint === fingerprint) {
        next.set(paragraphId, previous);
        continue;
      }
      if (paragraphSegments.length === 0 && paragraphHighlights.length === 0 && activeRanges.length === 0) continue;
      next.set(paragraphId, {
        fingerprint,
        snapshot: {
          segments: paragraphSegments,
          characters: input.characters,
          highlights: paragraphHighlights,
          reviewSegmentIds: reviewIds,
          correctionTargetId,
          activeRanges,
        },
      });
    }

    const changed = new Set<string>();
    for (const paragraphId of new Set([...this.decorations.keys(), ...next.keys()])) {
      if (this.decorations.get(paragraphId)?.snapshot !== next.get(paragraphId)?.snapshot) changed.add(paragraphId);
    }
    this.decorations = next;
    for (const paragraphId of changed) {
      for (const listener of this.listeners.get(paragraphId) ?? []) listener();
    }
  }
}

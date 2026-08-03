import type { Paragraph } from '../domain/types';
import type { SpeakInput, SpeakSequenceItemInput } from './tts';
import type { PlayableTtsSegment } from './tts-playback';
import { buildActiveTTSPlayback, type ActiveTTSPlayback } from './tts-playback-session';
import { waitForPlaybackDelay } from './tts-playback-delay';

export interface TTSPlaybackSessionRunnerResult {
  readonly completed: boolean;
  readonly stopped: boolean;
  readonly errorMessage?: string;
  readonly lastParagraphIndex?: number;
  readonly stopReason?: 'cancelled' | 'timer';
}

export interface RunTTSPlaybackSessionInput {
  readonly startIndex: number;
  readonly startQueueItemFingerprint?: string;
  readonly queueItemFingerprint?: (playable: PlayableTtsSegment) => string;
  readonly paragraphCount: number;
  readonly getParagraph: (index: number) => Promise<Paragraph | undefined>;
  readonly sourceParagraphIndex?: (paragraph: Paragraph, playbackIndex: number) => number;
  readonly buildPlayableSegments: (paragraph: Paragraph) => PlayableTtsSegment[];
  readonly shouldContinue: () => boolean;
  readonly signal?: AbortSignal;
  readonly waitForResume: () => Promise<boolean>;
  readonly playHostedSegment?: (playable: PlayableTtsSegment, paragraph: Paragraph) => Promise<boolean>;
  readonly canPrefetchHostedSegment?: (
    playable: PlayableTtsSegment,
    paragraph: Paragraph,
  ) => boolean | Promise<boolean>;
  readonly prefetchHostedSegment?: (playable: PlayableTtsSegment, paragraph: Paragraph) => void | Promise<void>;
  readonly hostedPrefetchDepth?: (playable: PlayableTtsSegment) => number;
  readonly buildSystemFallbackInput: (
    playable: PlayableTtsSegment,
  ) => Pick<SpeakInput, 'text' | 'rate' | 'pitch' | 'volume' | 'voiceURI' | 'mediaMetadata'>;
  readonly speakSystem: (input: SpeakInput) => Promise<void>;
  readonly speakSystemSequence?: (items: readonly SpeakSequenceItemInput[]) => Promise<void>;
  readonly stopSystem?: () => void;
  readonly sentencePauseMs?: number;
  readonly paragraphPauseMs?: number;
  readonly shouldStopAfterItem?: () => boolean;
  readonly onItemActiveChanged?: (active: boolean) => void;
  readonly onParagraphStart?: (index: number, paragraph: Paragraph) => void | Promise<void>;
  readonly onPlayableStart?: (
    playableIndex: number,
    playable: PlayableTtsSegment,
    paragraphIndex: number,
    paragraph: Paragraph,
  ) => void | Promise<void>;
  readonly onActivePlayback?: (playback: ActiveTTSPlayback | undefined) => void;
  readonly onError?: (message: string, paragraph: Paragraph, playable: PlayableTtsSegment) => void;
  readonly onFinished?: () => void;
}

export async function runTTSPlaybackSession(
  input: RunTTSPlaybackSessionInput,
): Promise<TTSPlaybackSessionRunnerResult> {
  if (input.startIndex < 0 || input.startIndex >= input.paragraphCount) {
    input.onActivePlayback?.(undefined);
    input.onFinished?.();
    return { completed: true, stopped: false };
  }

  if (input.speakSystemSequence && !input.playHostedSegment) {
    return runSystemSequence(input);
  }

  for (let paragraphIndex = input.startIndex; paragraphIndex < input.paragraphCount; paragraphIndex += 1) {
    if (!input.shouldContinue()) return stopped(paragraphIndex);
    const paragraph = await input.getParagraph(paragraphIndex);
    if (!input.shouldContinue()) return stopped(paragraphIndex);
    if (!paragraph) {
      input.onActivePlayback?.(undefined);
      input.onFinished?.();
      return { completed: true, stopped: false, lastParagraphIndex: paragraphIndex };
    }

    const sourceParagraphIndex = input.sourceParagraphIndex?.(paragraph, paragraphIndex) ?? paragraphIndex;
    await input.onParagraphStart?.(sourceParagraphIndex, paragraph);
    if (!input.shouldContinue()) return stopped(paragraphIndex);
    const playableSegments = input.buildPlayableSegments(paragraph);
    const requestedPlayableIndex =
      paragraphIndex === input.startIndex && input.startQueueItemFingerprint && input.queueItemFingerprint
        ? playableSegments.findIndex(
            (playable) => input.queueItemFingerprint?.(playable) === input.startQueueItemFingerprint,
          )
        : -1;
    const startPlayableIndex = requestedPlayableIndex >= 0 ? requestedPlayableIndex : 0;
    for (let playableIndex = startPlayableIndex; playableIndex < playableSegments.length; playableIndex += 1) {
      if (!input.shouldContinue() || !(await input.waitForResume())) return stopped(paragraphIndex);
      const playable = playableSegments[playableIndex];
      await input.onPlayableStart?.(playableIndex, playable, sourceParagraphIndex, paragraph);
      if (!input.shouldContinue()) return stopped(paragraphIndex);
      input.onActivePlayback?.(buildActiveTTSPlayback({ paragraph, playable }));
      void prefetchUpcomingPlayables({
        ...input,
        paragraph,
        paragraphIndex,
        playableIndex,
        playableSegments,
      });

      const hostedPlayed = await input.playHostedSegment?.(playable, paragraph);
      if (!input.shouldContinue() || !(await input.waitForResume())) {
        return stopped(paragraphIndex);
      }
      if (!hostedPlayed) {
        const systemResult = await speakSystemSegment(input, paragraph, playable);
        if (systemResult.errorMessage) {
          input.onActivePlayback?.(undefined);
          input.onError?.(systemResult.errorMessage, paragraph, playable);
          return {
            completed: false,
            stopped: true,
            errorMessage: systemResult.errorMessage,
            lastParagraphIndex: paragraphIndex,
          };
        }
      }
      if (input.shouldStopAfterItem?.()) return timerStopped(paragraphIndex);
      if (
        playableIndex + 1 < playableSegments.length &&
        !(await waitForPlaybackDelay({
          durationMs: input.sentencePauseMs ?? 0,
          shouldContinue: input.shouldContinue,
          waitForResume: input.waitForResume,
          signal: input.signal,
        }))
      )
        return stopped(paragraphIndex);
    }
    if (
      paragraphIndex + 1 < input.paragraphCount &&
      !(await waitForPlaybackDelay({
        durationMs: input.paragraphPauseMs ?? 0,
        shouldContinue: input.shouldContinue,
        waitForResume: input.waitForResume,
        signal: input.signal,
      }))
    )
      return stopped(paragraphIndex);
  }

  input.onActivePlayback?.(undefined);
  input.onFinished?.();
  return { completed: true, stopped: false, lastParagraphIndex: input.paragraphCount - 1 };
}

interface SystemSequenceEntry {
  readonly paragraphIndex: number;
  readonly sourceParagraphIndex: number;
  readonly playableIndex: number;
  readonly paragraph: Paragraph;
  readonly playable: PlayableTtsSegment;
  readonly pauseAfterMs: number;
}

const MAX_SYSTEM_SEQUENCE_WINDOW_ITEMS = 512;

async function runSystemSequence(input: RunTTSPlaybackSessionInput): Promise<TTSPlaybackSessionRunnerResult> {
  const entries: SystemSequenceEntry[] = [];
  for (let paragraphIndex = input.startIndex; paragraphIndex < input.paragraphCount; paragraphIndex += 1) {
    if (!input.shouldContinue()) return stopped(paragraphIndex);
    const paragraph = await input.getParagraph(paragraphIndex);
    if (!paragraph) break;
    const playableSegments = input.buildPlayableSegments(paragraph);
    const requestedPlayableIndex =
      paragraphIndex === input.startIndex && input.startQueueItemFingerprint && input.queueItemFingerprint
        ? playableSegments.findIndex(
            (playable) => input.queueItemFingerprint?.(playable) === input.startQueueItemFingerprint,
          )
        : -1;
    const startPlayableIndex = requestedPlayableIndex >= 0 ? requestedPlayableIndex : 0;
    for (let playableIndex = startPlayableIndex; playableIndex < playableSegments.length; playableIndex += 1) {
      entries.push({
        paragraphIndex,
        sourceParagraphIndex: input.sourceParagraphIndex?.(paragraph, paragraphIndex) ?? paragraphIndex,
        playableIndex,
        paragraph,
        playable: playableSegments[playableIndex],
        pauseAfterMs:
          playableIndex + 1 < playableSegments.length ? (input.sentencePauseMs ?? 0) : (input.paragraphPauseMs ?? 0),
      });
    }
  }
  if (entries.length === 0) {
    input.onActivePlayback?.(undefined);
    input.onFinished?.();
    return { completed: true, stopped: false };
  }

  return new Promise((resolve) => {
    let settled = false;
    let completedItems = 0;
    let activeParagraph = -1;
    const completedEntryIndexes = new Set<number>();
    const finish = (result: TTSPlaybackSessionRunnerResult) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', handleAbort);
      input.onItemActiveChanged?.(false);
      input.onActivePlayback?.(undefined);
      resolve(result);
    };
    const handleAbort = () => {
      input.stopSystem?.();
      finish(stopped(entries[Math.max(0, completedItems - 1)]?.paragraphIndex));
    };
    input.signal?.addEventListener('abort', handleAbort, { once: true });
    const items = entries.map<SpeakSequenceItemInput>((entry, index) => ({
      ...input.buildSystemFallbackInput(entry.playable),
      playbackAnchor: {
        kind: 'reflowable_text',
        bookId: entry.paragraph.novelId,
        chapterId: entry.paragraph.chapterId,
        blockId: entry.paragraph.id,
        blockIndex: entry.sourceParagraphIndex,
        startOffset:
          entry.playable.sourceRanges.find((range) => range.paragraphId === entry.paragraph.id)?.startOffset ?? 0,
        endOffset:
          entry.playable.sourceRanges.find((range) => range.paragraphId === entry.paragraph.id)?.endOffset ?? 0,
        queueItemFingerprint: input.queueItemFingerprint?.(entry.playable),
      },
      pauseAfterMs: index + 1 < entries.length ? entry.pauseAfterMs : 0,
      onStart: () => {
        if (settled || !input.shouldContinue()) return;
        if (activeParagraph !== entry.sourceParagraphIndex) {
          activeParagraph = entry.sourceParagraphIndex;
          void input.onParagraphStart?.(entry.sourceParagraphIndex, entry.paragraph);
        }
        void input.onPlayableStart?.(entry.playableIndex, entry.playable, entry.sourceParagraphIndex, entry.paragraph);
        input.onActivePlayback?.(buildActiveTTSPlayback({ paragraph: entry.paragraph, playable: entry.playable }));
        input.onItemActiveChanged?.(true);
      },
      onEnd: () => {
        if (settled) return;
        if (completedEntryIndexes.has(index)) return;
        completedEntryIndexes.add(index);
        completedItems += 1;
        input.onItemActiveChanged?.(false);
        if (input.shouldStopAfterItem?.()) {
          input.stopSystem?.();
          finish(timerStopped(entry.paragraphIndex));
          return;
        }
        if (completedItems === entries.length) {
          input.onFinished?.();
          finish({ completed: true, stopped: false, lastParagraphIndex: entry.paragraphIndex });
          return;
        }
        if ((index + 1) % MAX_SYSTEM_SEQUENCE_WINDOW_ITEMS === 0) {
          void startSequenceWindow(index + 1);
        }
      },
      onError: (message) => {
        input.stopSystem?.();
        input.onError?.(message, entry.paragraph, entry.playable);
        finish({
          completed: false,
          stopped: true,
          errorMessage: message,
          lastParagraphIndex: entry.paragraphIndex,
        });
      },
    }));
    const startSequenceWindow = async (startIndex: number) => {
      if (settled || !input.shouldContinue()) return;
      const windowItems = items.slice(startIndex, startIndex + MAX_SYSTEM_SEQUENCE_WINDOW_ITEMS);
      if (windowItems.length === 0) return;
      try {
        await input.speakSystemSequence!(windowItems);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        windowItems[0]?.onError?.(message || 'Android native TTS playlist could not start.');
      }
    };
    void startSequenceWindow(0);
  });
}

interface PrefetchInput extends RunTTSPlaybackSessionInput {
  readonly paragraph: Paragraph;
  readonly paragraphIndex: number;
  readonly playableIndex: number;
  readonly playableSegments: PlayableTtsSegment[];
}

async function prefetchUpcomingPlayables(input: PrefetchInput): Promise<void> {
  if (!input.prefetchHostedSegment || !input.shouldContinue()) return;
  const depth = Math.max(
    1,
    Math.min(3, Math.floor(input.hostedPrefetchDepth?.(input.playableSegments[input.playableIndex]) ?? 1)),
  );
  const targets = input.playableSegments
    .slice(input.playableIndex + 1)
    .map((playable) => ({ paragraph: input.paragraph, playable }))
    .slice(0, depth);
  for (
    let paragraphIndex = input.paragraphIndex + 1;
    targets.length < depth && paragraphIndex < input.paragraphCount;
    paragraphIndex += 1
  ) {
    const paragraph = await input.getParagraph(paragraphIndex);
    if (!paragraph || !input.shouldContinue()) break;
    for (const playable of input.buildPlayableSegments(paragraph)) {
      targets.push({ paragraph, playable });
      if (targets.length >= depth) break;
    }
  }
  const allowedByChapter = new Map<string, Promise<boolean>>();
  await Promise.all(
    targets.map(async (target) => {
      if (!input.shouldContinue()) return;
      if (input.canPrefetchHostedSegment) {
        const allowed =
          allowedByChapter.get(target.paragraph.chapterId) ??
          Promise.resolve(input.canPrefetchHostedSegment(target.playable, target.paragraph));
        allowedByChapter.set(target.paragraph.chapterId, allowed);
        if (!(await allowed)) return;
      }
      await input.prefetchHostedSegment?.(target.playable, target.paragraph);
    }),
  );
}

async function speakSystemSegment(
  input: RunTTSPlaybackSessionInput,
  paragraph: Paragraph,
  playable: PlayableTtsSegment,
): Promise<{ errorMessage?: string }> {
  if (input.signal?.aborted) return {};
  const fallbackInput = input.buildSystemFallbackInput(playable);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (errorMessage?: string) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', handleAbort);
      input.onItemActiveChanged?.(false);
      resolve({ errorMessage });
    };
    const handleAbort = () => finish();
    input.signal?.addEventListener('abort', handleAbort, { once: true });
    void input
      .speakSystem({
        ...fallbackInput,
        onStart: () => input.onItemActiveChanged?.(true),
        onEnd: () => finish(),
        onError: (message) => finish(message),
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(message || `TTS system playback failed for paragraph ${paragraph.index}`);
      });
  });
}

function stopped(lastParagraphIndex?: number): TTSPlaybackSessionRunnerResult {
  return {
    completed: false,
    stopped: true,
    lastParagraphIndex,
  };
}

function timerStopped(lastParagraphIndex: number): TTSPlaybackSessionRunnerResult {
  return { completed: false, stopped: true, stopReason: 'timer', lastParagraphIndex };
}

import { describe, expect, it } from 'vitest';
import type { Paragraph } from '../domain/types';
import type { SpeakInput } from '../providers/tts';
import type { PlayableTtsSegment } from '../providers/tts-playback';
import { runTTSPlaybackSession } from '../providers/tts-playback-session-runner';

const paragraphs: Paragraph[] = [paragraph('paragraph_1', 0, 'One. Two.'), paragraph('paragraph_2', 1, 'Three.')];

function paragraph(id: string, index: number, text: string): Paragraph {
  return {
    id,
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index,
    text,
    startOffsetInChapter: index * 100,
    endOffsetInChapter: index * 100 + text.length,
    textHash: `${id}_hash`,
  };
}

function playable(paragraphId: string, text: string, id: string): PlayableTtsSegment {
  return {
    paragraphId,
    text,
    speakerId: id,
    speakerLabel: id,
    emotion: 'neutral',
    rate: 1,
    sourceSegmentIds: [id],
    sourceRanges: [
      {
        segmentId: id,
        paragraphId,
        startOffset: 0,
        endOffset: text.length,
      },
    ],
  };
}

function playableForParagraph(paragraphValue: Paragraph): PlayableTtsSegment[] {
  if (paragraphValue.id === 'paragraph_1') {
    return [playable(paragraphValue.id, 'One.', 'seg_hosted'), playable(paragraphValue.id, 'Two.', 'seg_system')];
  }
  return [playable(paragraphValue.id, 'Three.', 'seg_next')];
}

describe('runTTSPlaybackSession', () => {
  it('walks paragraphs, plays hosted segments, falls back to system TTS, and prefetches ahead', async () => {
    const paragraphStarts: number[] = [];
    const hosted: string[] = [];
    const system: string[] = [];
    const prefetched: string[] = [];
    const active: Array<string | undefined> = [];

    const result = await runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: paragraphs.length,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: playableForParagraph,
      queueItemFingerprint: (segment) => `queue:${segment.sourceSegmentIds[0]}`,
      shouldContinue: () => true,
      waitForResume: async () => true,
      playHostedSegment: async (segment) => {
        hosted.push(segment.sourceSegmentIds[0] ?? segment.text);
        return segment.sourceSegmentIds.includes('seg_hosted');
      },
      prefetchHostedSegment: (segment) => {
        prefetched.push(segment.sourceSegmentIds[0] ?? segment.text);
      },
      buildSystemFallbackInput: (segment) => ({
        text: segment.text,
        rate: segment.rate,
        voiceURI: 'system-voice',
      }),
      speakSystem: async (input: SpeakInput) => {
        system.push(input.text);
        input.onEnd?.();
      },
      onParagraphStart: (index) => {
        paragraphStarts.push(index);
      },
      onActivePlayback: (playback) => active.push(playback?.segmentIds[0]),
    });
    await Promise.resolve();

    expect(result).toEqual({ completed: true, stopped: false, lastParagraphIndex: 1 });
    expect(paragraphStarts).toEqual([0, 1]);
    expect(hosted).toEqual(['seg_hosted', 'seg_system', 'seg_next']);
    expect(system).toEqual(['Two.', 'Three.']);
    expect(prefetched).toEqual(['seg_system', 'seg_next']);
    expect(active).toEqual(['seg_hosted', 'seg_system', 'seg_next', undefined]);
  });

  it('hands an all-system chapter to one native sequence with per-item cursor callbacks and pauses', async () => {
    const activated: string[] = [];
    const paragraphStarts: number[] = [];
    const active: Array<string | undefined> = [];
    const resultPromise = runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: paragraphs.length,
      getParagraph: async (index) => paragraphs[index],
      sourceParagraphIndex: (_paragraph, playbackIndex) => playbackIndex + 10,
      buildPlayableSegments: playableForParagraph,
      queueItemFingerprint: (segment) => `queue:${segment.sourceSegmentIds[0]}`,
      shouldContinue: () => true,
      waitForResume: async () => true,
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => {
        throw new Error('single-item speech should not run');
      },
      speakSystemSequence: async (items) => {
        expect(items.map((item) => item.pauseAfterMs)).toEqual([180, 420, 0]);
        expect(items[0].playbackAnchor).toMatchObject({
          kind: 'reflowable_text',
          bookId: paragraphs[0].novelId,
          chapterId: paragraphs[0].chapterId,
          blockId: paragraphs[0].id,
          blockIndex: 10,
          queueItemFingerprint: 'queue:seg_hosted',
        });
        for (const item of items) {
          item.onStart?.();
          item.onEnd?.();
        }
      },
      sentencePauseMs: 180,
      paragraphPauseMs: 420,
      onParagraphStart: (index) => {
        paragraphStarts.push(index);
      },
      onPlayableStart: (_index, segment) => {
        activated.push(segment.sourceSegmentIds[0]);
      },
      onActivePlayback: (playback) => active.push(playback?.segmentIds[0]),
    });

    await expect(resultPromise).resolves.toEqual({ completed: true, stopped: false, lastParagraphIndex: 1 });
    expect(paragraphStarts).toEqual([10, 11]);
    expect(activated).toEqual(['seg_hosted', 'seg_system', 'seg_next']);
    expect(active).toEqual(['seg_hosted', 'seg_system', 'seg_next', undefined]);
  });

  it('continues an Android system chapter in bounded native playlist windows', async () => {
    const paragraphCount = 513;
    const windows: number[] = [];
    const activated: number[] = [];
    const resultPromise = runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount,
      getParagraph: async (index) => paragraph(`paragraph_${index}`, index, `Sentence ${index}.`),
      buildPlayableSegments: (value) => [playable(value.id, value.text, `segment_${value.index}`)],
      shouldContinue: () => true,
      waitForResume: async () => true,
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => {
        throw new Error('single-item speech should not run');
      },
      speakSystemSequence: async (items) => {
        windows.push(items.length);
        for (const item of items) {
          item.onStart?.();
          item.onEnd?.();
        }
      },
      onParagraphStart: (index) => {
        activated.push(index);
      },
    });

    await expect(resultPromise).resolves.toEqual({
      completed: true,
      stopped: false,
      lastParagraphIndex: paragraphCount - 1,
    });
    expect(windows).toEqual([512, 1]);
    expect(activated).toHaveLength(paragraphCount);
    expect(activated.at(-1)).toBe(paragraphCount - 1);
  });

  it('stops cleanly when resume is not allowed', async () => {
    const result = await runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: paragraphs.length,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: playableForParagraph,
      shouldContinue: () => true,
      waitForResume: async () => false,
      playHostedSegment: async () => {
        throw new Error('hosted playback should not run');
      },
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => {
        throw new Error('system playback should not run');
      },
    });

    expect(result).toEqual({ completed: false, stopped: true, lastParagraphIndex: 0 });
  });

  it('resumes from the matching queue item and reports each activated item', async () => {
    const played: string[] = [];
    const activated: string[] = [];
    const result = await runTTSPlaybackSession({
      startIndex: 0,
      startQueueItemFingerprint: 'queue:seg_system',
      queueItemFingerprint: (segment) => `queue:${segment.sourceSegmentIds[0]}`,
      paragraphCount: 1,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: playableForParagraph,
      shouldContinue: () => true,
      waitForResume: async () => true,
      playHostedSegment: async (segment) => {
        played.push(segment.sourceSegmentIds[0]);
        return true;
      },
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => undefined,
      onPlayableStart: (_index, segment) => {
        activated.push(segment.sourceSegmentIds[0]);
      },
    });

    expect(result).toEqual({ completed: true, stopped: false, lastParagraphIndex: 0 });
    expect(activated).toEqual(['seg_system']);
    expect(played).toEqual(['seg_system']);
  });

  it('does not prefetch hosted TTS when the prefetch guard rejects the target', async () => {
    const prefetchCandidates: string[] = [];
    const prefetched: string[] = [];

    const result = await runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: 1,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: playableForParagraph,
      shouldContinue: () => true,
      waitForResume: async () => true,
      playHostedSegment: async () => true,
      canPrefetchHostedSegment: async (segment) => {
        prefetchCandidates.push(segment.sourceSegmentIds[0] ?? segment.text);
        return false;
      },
      prefetchHostedSegment: (segment) => {
        prefetched.push(segment.sourceSegmentIds[0] ?? segment.text);
      },
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => {
        throw new Error('system playback should not run');
      },
    });
    await Promise.resolve();

    expect(result).toEqual({ completed: true, stopped: false, lastParagraphIndex: 0 });
    expect(prefetchCandidates).toEqual(['seg_system']);
    expect(prefetched).toEqual([]);
  });

  it('prefetches up to the adaptive depth across a paragraph boundary', async () => {
    const prefetched: string[] = [];
    const result = await runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: paragraphs.length,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: playableForParagraph,
      shouldContinue: () => true,
      waitForResume: async () => true,
      playHostedSegment: async () => true,
      hostedPrefetchDepth: () => 2,
      prefetchHostedSegment: (segment) => {
        prefetched.push(segment.sourceSegmentIds[0] ?? segment.text);
      },
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => undefined,
    });
    await Promise.resolve();
    expect(result.completed).toBe(true);
    expect(prefetched.slice(0, 2)).toEqual(['seg_system', 'seg_next']);
  });

  it('does not start playback when the session is cancelled after paragraph activation', async () => {
    let cancelled = false;
    const hosted: string[] = [];

    const result = await runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: paragraphs.length,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: playableForParagraph,
      shouldContinue: () => !cancelled,
      waitForResume: async () => true,
      playHostedSegment: async (segment) => {
        hosted.push(segment.sourceSegmentIds[0] ?? segment.text);
        return true;
      },
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => {
        throw new Error('system playback should not run');
      },
      onParagraphStart: () => {
        cancelled = true;
      },
    });

    expect(result).toEqual({ completed: false, stopped: true, lastParagraphIndex: 0 });
    expect(hosted).toEqual([]);
  });

  it('reports system TTS errors and clears active playback', async () => {
    const errors: string[] = [];
    const active: Array<string | undefined> = [];

    const result = await runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: 1,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: (paragraphValue) => [playable(paragraphValue.id, 'Broken.', 'seg_broken')],
      shouldContinue: () => true,
      waitForResume: async () => true,
      playHostedSegment: async () => false,
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async (input) => input.onError?.('speech failed'),
      onActivePlayback: (playback) => active.push(playback?.segmentIds[0]),
      onError: (message) => errors.push(message),
    });

    expect(result).toEqual({
      completed: false,
      stopped: true,
      errorMessage: 'speech failed',
      lastParagraphIndex: 0,
    });
    expect(errors).toEqual(['speech failed']);
    expect(active).toEqual(['seg_broken', undefined]);
  });

  it('stops a pending system speech wait when the session is aborted', async () => {
    const controller = new AbortController();
    let continuing = true;
    const resultPromise = runTTSPlaybackSession({
      startIndex: 0,
      paragraphCount: 1,
      getParagraph: async (index) => paragraphs[index],
      buildPlayableSegments: (paragraphValue) => [playable(paragraphValue.id, 'Pending.', 'seg_pending')],
      shouldContinue: () => continuing,
      signal: controller.signal,
      waitForResume: async () => true,
      playHostedSegment: async () => false,
      buildSystemFallbackInput: (segment) => ({ text: segment.text, rate: 1 }),
      speakSystem: async () => undefined,
    });

    await Promise.resolve();
    continuing = false;
    controller.abort();

    await expect(resultPromise).resolves.toEqual({ completed: false, stopped: true, lastParagraphIndex: 0 });
  });
});

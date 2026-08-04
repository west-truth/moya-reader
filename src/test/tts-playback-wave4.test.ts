import { describe, expect, it, vi } from 'vitest';
import type { Paragraph } from '../domain/types';
import { defaultSettings } from '../repositories/reader-defaults';
import { nextPlaybackChapter } from '../providers/book-playback-coordinator';
import { splitPlayableTtsSegment } from '../providers/tts-sentence-planner';
import {
  resolveTTSPlaybackSettings,
  updateBookTTSPlaybackOverride,
  updateGlobalTTSPlaybackSettings,
} from '../providers/tts-playback-settings';
import { TTSActiveSleepTimer } from '../providers/tts-sleep-timer';
import { ttsPlaybackSettingsFingerprint, validTTSPlaybackResume } from '../providers/tts-playback-resume';
import { BrowserMediaSessionAdapter } from '../platform/media-session-adapter';

const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  index: 1,
  text: '첫 문장입니다.  둘째 문장입니다!\n마지막.',
  startOffsetInChapter: 0,
  endOffsetInChapter: 26,
  textHash: 'paragraph_hash',
};

describe('W4 TTS playback contracts', () => {
  it('splits speech without losing or duplicating non-whitespace source offsets', () => {
    const planned = splitPlayableTtsSegment(paragraph, {
      paragraphId: paragraph.id,
      text: paragraph.text,
      speakerId: 'narrator',
      speakerLabel: '내레이터',
      emotion: 'neutral',
      contentType: 'narration',
      rate: 1,
      sourceSegmentIds: ['segment_1'],
      sourceRanges: [
        {
          segmentId: 'segment_1',
          paragraphId: paragraph.id,
          startOffset: 0,
          endOffset: paragraph.text.length,
        },
      ],
    });
    const coverage = Array.from({ length: paragraph.text.length }, () => 0);
    for (const item of planned) {
      for (const range of item.sourceRanges) {
        for (let index = range.startOffset; index < range.endOffset; index += 1) coverage[index] += 1;
      }
    }
    paragraph.text.split('').forEach((character, index) => {
      if (!/\s/u.test(character)) expect(coverage[index]).toBe(1);
    });
    expect(planned.map((item) => item.text)).toEqual(['첫 문장입니다.', '둘째 문장입니다!', '마지막.']);
  });

  it('merges a sparse book override over normalized global settings', () => {
    const global = updateGlobalTTSPlaybackSettings(defaultSettings, {
      rate: 1.4,
      volume: 0.7,
      sleepTimerDefault: 30,
    });
    const withBook = updateBookTTSPlaybackOverride(global, 'book_1', {
      rate: 1.1,
      sentencePauseMs: 500,
      sleepTimerDefault: null,
      footnotePlayback: 'immediate',
    });
    expect(resolveTTSPlaybackSettings(withBook, 'book_1')).toMatchObject({
      rate: 1.1,
      volume: 0.7,
      sentencePauseMs: 500,
      sleepTimerDefault: undefined,
      footnotePlayback: 'immediate',
    });
    expect(resolveTTSPlaybackSettings(withBook, 'book_2').rate).toBe(1.4);
    expect(resolveTTSPlaybackSettings(withBook, 'book_2').footnotePlayback).toBe('end_of_chapter');
  });

  it('keeps offline-only playback explicit and disabled for older settings', () => {
    expect(resolveTTSPlaybackSettings(defaultSettings, 'book_1').offlineOnly).toBe(false);
    const updated = updateGlobalTTSPlaybackSettings(defaultSettings, { offlineOnly: true });
    expect(resolveTTSPlaybackSettings(updated, 'book_1').offlineOnly).toBe(true);
  });

  it('counts only resumed active playback toward a minute timer', () => {
    let now = 0;
    const timer = new TTSActiveSleepTimer(() => now);
    timer.start(10);
    now += 1_000;
    timer.pause();
    now += 30_000;
    expect(timer.remainingSeconds).toBe(599);
    timer.resume();
    now += 599_000;
    expect(timer.shouldStopAfterItem()).toBe(true);
  });

  it('selects the next chapter by stable chapter index', () => {
    const chapter = (id: string, index: number) => ({
      id,
      novelId: 'book_1',
      index,
      title: id,
      normalizedText: '',
      textHash: id,
      rawStartOffset: 0,
      rawEndOffset: 0,
      characterCount: 0,
      paragraphCount: 0,
      createdAt: '',
      updatedAt: '',
    });
    expect(nextPlaybackChapter([chapter('c3', 3), chapter('c1', 1), chapter('c2', 2)], 'c1')?.id).toBe('c2');
    expect(nextPlaybackChapter([chapter('c1', 1)], 'c1')).toBeUndefined();
  });

  it('invalidates a saved listening position after content or voice settings change', () => {
    const fingerprint = ttsPlaybackSettingsFingerprint({
      settings: defaultSettings.ttsPlayback,
      voiceRevision: 'voices_1',
    });
    const record = {
      schemaVersion: 1 as const,
      bookId: 'book_1',
      chapterId: 'chapter_1',
      paragraphIndex: 2,
      contentRevisionId: 'content_1',
      settingsFingerprint: fingerprint,
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    expect(validTTSPlaybackResume(record, { contentRevisionId: 'content_1', settingsFingerprint: fingerprint })).toBe(
      true,
    );
    expect(validTTSPlaybackResume(record, { contentRevisionId: 'content_2', settingsFingerprint: fingerprint })).toBe(
      false,
    );
  });

  it('registers and clears browser media session handlers', () => {
    const handlers = new Map<string, (() => void) | null>();
    const session = {
      metadata: null,
      playbackState: 'none' as MediaSessionPlaybackState,
      setActionHandler: vi.fn((action: MediaSessionAction, handler: (() => void) | null) => {
        handlers.set(action, handler);
      }),
    };
    class Metadata {
      constructor(readonly input: MediaMetadataInit) {}
    }
    const adapter = new BrowserMediaSessionAdapter(session, Metadata as unknown as typeof MediaMetadata);
    const play = vi.fn();
    adapter.setMetadata({ title: 'Chapter', album: 'Book' });
    adapter.setHandlers({ play });
    handlers.get('play')?.();
    expect(play).toHaveBeenCalledOnce();
    adapter.clear();
    expect(session.playbackState).toBe('none');
    expect(session.metadata).toBeNull();
    expect(handlers.get('play')).toBeNull();
  });
});

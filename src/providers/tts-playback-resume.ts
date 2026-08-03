import type { TTSPlaybackSettings } from '../domain/types';
import { persistentId128 } from '../domain/id-hash-contract';
import type { PlayableTtsSegment } from './tts-playback';

const STORAGE_KEY = 'noveldesk.tts-playback-resume.v1';

export interface TTSPlaybackResumeRecord {
  readonly schemaVersion: 1;
  readonly bookId: string;
  readonly chapterId: string;
  readonly paragraphIndex: number;
  readonly contentRevisionId?: string;
  readonly settingsFingerprint: string;
  readonly updatedAt: string;
}

export function ttsQueueItemFingerprint(playable: PlayableTtsSegment): string {
  const ranges = playable.sourceRanges.map((range) => [
    range.paragraphId,
    range.startOffset,
    range.endOffset,
    range.segmentId,
  ]);
  return persistentId128('tts_queue_item', [playable.paragraphId, JSON.stringify(ranges), playable.text]);
}

export function ttsPlaybackSettingsFingerprint(input: {
  readonly settings: TTSPlaybackSettings;
  readonly voiceRevision: string;
}): string {
  return JSON.stringify({
    rate: input.settings.rate,
    pitch: input.settings.pitch,
    skippedContentTypes: [...input.settings.skippedContentTypes].sort(),
    footnotePlayback: input.settings.footnotePlayback,
    voiceRevision: input.voiceRevision,
  });
}

export function loadTTSPlaybackResume(bookId: string): TTSPlaybackResumeRecord | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<TTSPlaybackResumeRecord> | null;
    if (
      value?.schemaVersion !== 1 ||
      value.bookId !== bookId ||
      !value.chapterId ||
      !Number.isInteger(value.paragraphIndex) ||
      (value.paragraphIndex ?? -1) < 0 ||
      !value.settingsFingerprint ||
      !value.updatedAt
    )
      return undefined;
    return value as TTSPlaybackResumeRecord;
  } catch {
    return undefined;
  }
}

export function saveTTSPlaybackResume(record: TTSPlaybackResumeRecord): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Resume is a convenience record; playback must continue if storage is unavailable.
  }
}

export function clearTTSPlaybackResume(bookId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = loadTTSPlaybackResume(bookId);
    if (current?.bookId === bookId) localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

export function validTTSPlaybackResume(
  record: TTSPlaybackResumeRecord | undefined,
  input: { readonly contentRevisionId?: string; readonly settingsFingerprint: string },
): record is TTSPlaybackResumeRecord {
  return Boolean(
    record &&
    record.settingsFingerprint === input.settingsFingerprint &&
    record.contentRevisionId === input.contentRevisionId,
  );
}

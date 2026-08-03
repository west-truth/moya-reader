import { defaultSettings } from '../../../../../src/repositories/reader-defaults';
import type {
  AnalysisStatus,
  ReaderHighlight,
  ReaderSettings,
  TTSPlaybackSettings,
  TTSPlaybackSettingsOverride,
} from '@noveldesk/contracts';
import { normalizeBookMetadataPatch, type NormalizedBookMetadataPatch } from '@noveldesk/text-core/library-metadata';

export interface BookPatchBody extends NormalizedBookMetadataPatch {
  analysisStatus?: AnalysisStatus;
  expectedRevision?: number;
}

export interface ReadingPositionBody {
  chapterId?: string;
  paragraphId?: string;
  paragraphIndex?: number;
  offsetInParagraph?: number;
  chapterProgress?: number;
  scrollTop?: number;
  deviceId?: string;
  updatedAt?: string;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ValidReadingPositionBody = Required<Pick<ReadingPositionBody, 'chapterId' | 'updatedAt'>> &
  ReadingPositionBody;

export type ValidReadingPositionDeleteBody = Required<Pick<ReadingPositionBody, 'updatedAt'>> &
  Pick<ReadingPositionBody, 'deviceId'>;

export type ValidBookmarkBody = Record<string, unknown> & {
  id: string;
  chapterId: string;
  paragraphId?: string;
  label: string;
  progress: number;
  scrollTop: number;
  createdAt: string;
};

export type ValidHighlightBody = Record<string, unknown> & {
  id: string;
  chapterId: string;
  paragraphId: string;
  quote: string;
  color: ReaderHighlight['color'];
  progress: number;
  createdAt: string;
  updatedAt: string;
};

export type ValidNoteBody = Record<string, unknown> & {
  id: string;
  chapterId: string;
  paragraphId?: string;
  quote?: string;
  body: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
};

const analysisStatuses: AnalysisStatus[] = [
  'not_analyzed',
  'mock_ready',
  'queued',
  'building_graph',
  'analyzing_characters',
  'labeling_segments',
  'validating',
  'ready',
  'needs_review',
  'failed',
  'cancelled',
];

function recordBody(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : undefined;
}

function numberField(body: Record<string, unknown>, field: string, fallback = 0): number {
  const value = body[field];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function optionalIsoDateField(
  body: Record<string, unknown>,
  field: string,
  fallback = new Date().toISOString(),
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? value : undefined;
}

function validProgress(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validateTTSPlaybackSettings(
  value: unknown,
  fallback: TTSPlaybackSettings,
): ValidationResult<TTSPlaybackSettings> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'ttsPlayback must be an object' };
  const next = { ...fallback, schemaVersion: 1 as const };
  const ranges = {
    rate: [0.5, 2.5],
    pitch: [0.5, 2],
    volume: [0, 1],
    sentencePauseMs: [0, 2_000],
    paragraphPauseMs: [0, 5_000],
    chapterPauseMs: [0, 10_000],
  } as const;
  for (const field of Object.keys(ranges) as Array<keyof typeof ranges>) {
    if (body[field] === undefined) continue;
    const parsed = numberField(body, field);
    const [minimum, maximum] = ranges[field];
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
      return { ok: false, error: `ttsPlayback.${field} is out of range` };
    }
    next[field] = field.endsWith('Ms') ? Math.round(parsed) : parsed;
  }
  if (body.chapterEndBehavior !== undefined) {
    if (body.chapterEndBehavior !== 'stop' && body.chapterEndBehavior !== 'continue') {
      return { ok: false, error: 'ttsPlayback.chapterEndBehavior is invalid' };
    }
    next.chapterEndBehavior = body.chapterEndBehavior;
  }
  if (body.sleepTimerDefault !== undefined) {
    const timer = body.sleepTimerDefault;
    if (![10, 20, 30, 60, 'end_of_chapter'].includes(timer as never)) {
      return { ok: false, error: 'ttsPlayback.sleepTimerDefault is invalid' };
    }
    next.sleepTimerDefault = timer as TTSPlaybackSettings['sleepTimerDefault'];
  } else {
    delete next.sleepTimerDefault;
  }
  if (body.skippedContentTypes !== undefined) {
    if (
      !Array.isArray(body.skippedContentTypes) ||
      body.skippedContentTypes.some((item) => !['author_note', 'system_message', 'sfx'].includes(String(item)))
    ) {
      return { ok: false, error: 'ttsPlayback.skippedContentTypes is invalid' };
    }
    next.skippedContentTypes = [...new Set(body.skippedContentTypes)] as TTSPlaybackSettings['skippedContentTypes'];
  }
  return { ok: true, value: next };
}

export function validateBookPatchBody(value: unknown): ValidationResult<BookPatchBody> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'body must be an object' };
  if (body.title !== undefined && typeof body.title !== 'string') {
    return { ok: false, error: 'title must be a string' };
  }
  if (body.favorite !== undefined && typeof body.favorite !== 'boolean') {
    return { ok: false, error: 'favorite must be boolean' };
  }
  for (const field of ['author', 'seriesTitle', 'description', 'language'] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
      return { ok: false, error: `${field} must be a string or null` };
    }
  }
  if (body.seriesIndex !== undefined && body.seriesIndex !== null && typeof body.seriesIndex !== 'number') {
    return { ok: false, error: 'seriesIndex must be a number or null' };
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))) {
    return { ok: false, error: 'tags must be a string array' };
  }
  if (body.coverFit !== undefined && body.coverFit !== 'crop' && body.coverFit !== 'contain') {
    return { ok: false, error: 'coverFit is invalid' };
  }
  for (const field of ['coverPositionX', 'coverPositionY'] as const) {
    if (body[field] !== undefined && typeof body[field] !== 'number') {
      return { ok: false, error: `${field} must be a number` };
    }
  }
  if (
    body.expectedRevision !== undefined &&
    (typeof body.expectedRevision !== 'number' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0)
  ) {
    return { ok: false, error: 'expectedRevision must be a non-negative integer' };
  }
  if (body.analysisStatus !== undefined && !analysisStatuses.includes(String(body.analysisStatus) as AnalysisStatus)) {
    return { ok: false, error: 'analysisStatus is invalid' };
  }
  try {
    const metadata = normalizeBookMetadataPatch(body);
    return {
      ok: true,
      value: {
        ...metadata,
        analysisStatus: body.analysisStatus as AnalysisStatus | undefined,
        expectedRevision: body.expectedRevision as number | undefined,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'book metadata is invalid' };
  }
}

export function validateReadingPositionBody(value: unknown): ValidationResult<ValidReadingPositionBody> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'body must be an object' };
  const chapterId = stringField(body, 'chapterId');
  if (!chapterId) return { ok: false, error: 'chapterId is required' };
  const paragraphIndex = numberField(body, 'paragraphIndex');
  const offsetInParagraph = numberField(body, 'offsetInParagraph');
  const chapterProgress = numberField(body, 'chapterProgress');
  const scrollTop = numberField(body, 'scrollTop');
  const updatedAt = optionalIsoDateField(body, 'updatedAt');
  if (!validNonNegative(paragraphIndex)) {
    return { ok: false, error: 'paragraphIndex must be non-negative' };
  }
  if (!validNonNegative(offsetInParagraph)) {
    return { ok: false, error: 'offsetInParagraph must be non-negative' };
  }
  if (!validProgress(chapterProgress)) {
    return { ok: false, error: 'chapterProgress must be between 0 and 1' };
  }
  if (!validNonNegative(scrollTop)) {
    return { ok: false, error: 'scrollTop must be non-negative' };
  }
  if (!updatedAt) return { ok: false, error: 'updatedAt must be an ISO date string' };
  return {
    ok: true,
    value: {
      chapterId,
      paragraphId: optionalStringField(body, 'paragraphId'),
      paragraphIndex,
      offsetInParagraph,
      chapterProgress,
      scrollTop,
      deviceId: optionalStringField(body, 'deviceId'),
      updatedAt,
    },
  };
}

export function validateReadingPositionDeleteBody(value: unknown): ValidationResult<ValidReadingPositionDeleteBody> {
  const body = recordBody(value ?? {});
  if (!body) return { ok: false, error: 'body must be an object' };
  const updatedAt = optionalIsoDateField(body, 'updatedAt');
  if (!updatedAt) return { ok: false, error: 'updatedAt must be an ISO date string' };
  return {
    ok: true,
    value: {
      deviceId: optionalStringField(body, 'deviceId'),
      updatedAt,
    },
  };
}

export function validateSettingsBody(value: unknown): ValidationResult<ReaderSettings> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'settings body must be an object' };
  const next = { ...defaultSettings };
  const theme = body.theme;
  if (theme !== undefined) {
    if (!['light', 'dark', 'sepia', 'midnight'].includes(String(theme))) {
      return { ok: false, error: 'theme is invalid' };
    }
    next.theme = theme as ReaderSettings['theme'];
  }
  const font = body.font;
  if (font !== undefined) {
    if (!['serif', 'sans', 'mono'].includes(String(font))) {
      return { ok: false, error: 'font is invalid' };
    }
    next.font = font as ReaderSettings['font'];
  }
  const flow = body.flow;
  if (flow !== undefined) {
    if (!['scroll', 'page'].includes(String(flow))) {
      return { ok: false, error: 'flow is invalid' };
    }
    next.flow = flow as ReaderSettings['flow'];
  }
  const numericFields: Array<
    keyof Pick<
      ReaderSettings,
      'fontSize' | 'lineHeight' | 'paragraphSpacing' | 'marginX' | 'marginY' | 'contentWidth' | 'ttsSpeed'
    >
  > = ['fontSize', 'lineHeight', 'paragraphSpacing', 'marginX', 'marginY', 'contentWidth', 'ttsSpeed'];
  for (const field of numericFields) {
    if (body[field] === undefined) continue;
    const fieldValue = numberField(body, field);
    if (!validNonNegative(fieldValue)) {
      return { ok: false, error: `${field} must be non-negative` };
    }
    next[field] = fieldValue;
  }
  const keepScreenChrome = body.keepScreenChrome;
  if (keepScreenChrome !== undefined) {
    if (typeof keepScreenChrome !== 'boolean') {
      return { ok: false, error: 'keepScreenChrome must be boolean' };
    }
    next.keepScreenChrome = keepScreenChrome;
  }
  const ttsVoiceURI = optionalStringField(body, 'ttsVoiceURI');
  if (ttsVoiceURI !== undefined) next.ttsVoiceURI = ttsVoiceURI;
  if (body.ttsPlayback !== undefined) {
    const playback = validateTTSPlaybackSettings(body.ttsPlayback, {
      ...next.ttsPlayback,
      rate: next.ttsSpeed,
    });
    if (!playback.ok) return playback;
    next.ttsPlayback = playback.value;
    next.ttsSpeed = playback.value.rate;
  }
  if (body.ttsBookOverrides !== undefined) {
    const overrides = recordBody(body.ttsBookOverrides);
    if (!overrides) return { ok: false, error: 'ttsBookOverrides must be an object' };
    next.ttsBookOverrides = {};
    for (const [bookId, value] of Object.entries(overrides)) {
      const raw = recordBody(value);
      if (!raw) return { ok: false, error: `ttsBookOverrides.${bookId} must be an object` };
      const merged = { ...next.ttsPlayback, ...raw };
      if (raw.sleepTimerDefault === null) delete merged.sleepTimerDefault;
      const parsed = validateTTSPlaybackSettings(merged, next.ttsPlayback);
      if (!parsed.ok) return parsed;
      const sparse: TTSPlaybackSettingsOverride = {};
      for (const field of [
        'rate',
        'pitch',
        'volume',
        'sentencePauseMs',
        'paragraphPauseMs',
        'chapterPauseMs',
        'chapterEndBehavior',
        'sleepTimerDefault',
        'skippedContentTypes',
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(raw, field)) {
          Object.assign(sparse, {
            [field]: field === 'sleepTimerDefault' && raw[field] === null ? null : parsed.value[field],
          });
        }
      }
      next.ttsBookOverrides[bookId] = sparse;
    }
  }
  if (body.readingProfile !== undefined) {
    const profile = recordBody(body.readingProfile);
    if (!profile) return { ok: false, error: 'readingProfile must be an object' };
    next.readingProfile = { ...defaultSettings.readingProfile, ...profile } as ReaderSettings['readingProfile'];
  }
  if (body.readingBookOverrides !== undefined) {
    const overrides = recordBody(body.readingBookOverrides);
    if (!overrides || Object.values(overrides).some((value) => !recordBody(value))) {
      return { ok: false, error: 'readingBookOverrides must contain object values' };
    }
    next.readingBookOverrides = overrides as ReaderSettings['readingBookOverrides'];
  }
  if (body.gestureBindings !== undefined) {
    const bindings = recordBody(body.gestureBindings);
    if (!bindings) return { ok: false, error: 'gestureBindings must be an object' };
    const allowed = new Set([
      'previous_page',
      'next_page',
      'toggle_chrome',
      'open_toc',
      'open_settings',
      'toggle_tts',
      'none',
    ]);
    const required = ['tapLeft', 'tapCenter', 'tapRight', 'swipeLeft', 'swipeRight'];
    if (required.some((field) => !allowed.has(String(bindings[field])))) {
      return { ok: false, error: 'gestureBindings contains an invalid action' };
    }
    next.gestureBindings = { ...defaultSettings.gestureBindings, ...bindings } as ReaderSettings['gestureBindings'];
  }
  return { ok: true, value: next };
}

export function validateBookmarkBody(value: unknown): ValidationResult<ValidBookmarkBody> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'bookmark body must be an object' };
  const id = stringField(body, 'id');
  const chapterId = stringField(body, 'chapterId');
  const label = stringField(body, 'label');
  const progress = numberField(body, 'progress');
  const scrollTop = numberField(body, 'scrollTop');
  const createdAt = optionalIsoDateField(body, 'createdAt');
  if (!id) return { ok: false, error: 'id is required' };
  if (!chapterId) return { ok: false, error: 'chapterId is required' };
  if (!label) return { ok: false, error: 'label is required' };
  if (!validProgress(progress)) return { ok: false, error: 'progress must be between 0 and 1' };
  if (!validNonNegative(scrollTop)) {
    return { ok: false, error: 'scrollTop must be non-negative' };
  }
  if (!createdAt) return { ok: false, error: 'createdAt must be an ISO date string' };
  return {
    ok: true,
    value: {
      ...body,
      id,
      chapterId,
      label,
      progress,
      scrollTop,
      createdAt,
      paragraphId: optionalStringField(body, 'paragraphId'),
    },
  };
}

export function validateHighlightBody(value: unknown): ValidationResult<ValidHighlightBody> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'highlight body must be an object' };
  const id = stringField(body, 'id');
  const chapterId = stringField(body, 'chapterId');
  const paragraphId = stringField(body, 'paragraphId');
  const quote = stringField(body, 'quote');
  const color = stringField(body, 'color') as ReaderHighlight['color'] | undefined;
  const progress = numberField(body, 'progress');
  const createdAt = optionalIsoDateField(body, 'createdAt');
  const updatedAt = optionalIsoDateField(body, 'updatedAt');
  if (!id) return { ok: false, error: 'id is required' };
  if (!chapterId) return { ok: false, error: 'chapterId is required' };
  if (!paragraphId) return { ok: false, error: 'paragraphId is required' };
  if (!quote) return { ok: false, error: 'quote is required' };
  if (!color || !['yellow', 'green', 'blue', 'pink'].includes(color)) {
    return { ok: false, error: 'color is invalid' };
  }
  if (!validProgress(progress)) return { ok: false, error: 'progress must be between 0 and 1' };
  if (!createdAt) return { ok: false, error: 'createdAt must be an ISO date string' };
  if (!updatedAt) return { ok: false, error: 'updatedAt must be an ISO date string' };
  return {
    ok: true,
    value: { ...body, id, chapterId, paragraphId, quote, color, progress, createdAt, updatedAt },
  };
}

export function validateNoteBody(value: unknown): ValidationResult<ValidNoteBody> {
  const body = recordBody(value);
  if (!body) return { ok: false, error: 'note body must be an object' };
  const id = stringField(body, 'id');
  const chapterId = stringField(body, 'chapterId');
  const noteBody = stringField(body, 'body');
  const progress = numberField(body, 'progress');
  const createdAt = optionalIsoDateField(body, 'createdAt');
  const updatedAt = optionalIsoDateField(body, 'updatedAt');
  if (!id) return { ok: false, error: 'id is required' };
  if (!chapterId) return { ok: false, error: 'chapterId is required' };
  if (!noteBody) return { ok: false, error: 'body is required' };
  if (!validProgress(progress)) return { ok: false, error: 'progress must be between 0 and 1' };
  if (!createdAt) return { ok: false, error: 'createdAt must be an ISO date string' };
  if (!updatedAt) return { ok: false, error: 'updatedAt must be an ISO date string' };
  return {
    ok: true,
    value: {
      ...body,
      id,
      chapterId,
      paragraphId: optionalStringField(body, 'paragraphId'),
      quote: optionalStringField(body, 'quote'),
      body: noteBody,
      progress,
      createdAt,
      updatedAt,
    },
  };
}

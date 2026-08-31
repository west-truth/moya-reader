import { ChapterSplitMode, EncodingMode, Novel } from '../../domain/types';

export type ImportJobStatus =
  'queued' | 'reading' | 'decoding' | 'splitting_chapters' | 'writing' | 'cancelling' | 'ready' | 'failed';

export type ImportProgressSubphase =
  | 'queued'
  | 'reading_chunks'
  | 'hashing_source'
  | 'decoding_text'
  | 'normalizing_text'
  | 'hashing_normalized_text'
  | 'detecting_chapters'
  | 'building_chapters'
  | 'staging_chapters'
  | 'writing_pages'
  | 'activating_revision'
  | 'cancelling_cleanup'
  | 'complete';

export interface ImportProgress {
  jobId: string;
  status: ImportJobStatus;
  subphase?: ImportProgressSubphase;
  bytesRead: number;
  totalBytes: number;
  chaptersDetected: number;
  paragraphsWritten: number;
  message?: string;
}

export interface ImportFileInput {
  file: File;
  encoding: EncodingMode;
  chapterSplitMode?: ChapterSplitMode;
  clientBookId?: string;
  /**
   * The input contains only new or changed image-series sections. Supporting
   * local and Hosted boundaries update a manifest of immutable comic originals
   * before their normal atomic activation path. Text/EPUB imports do not use this mode.
   */
  importMode?: 'replace_book' | 'append_image_series';
  /**
   * Required with `append_image_series`. Supporting boundaries may merge new
   * sections over a newer base, but reject stale replacements of an existing section.
   */
  baseActiveContentRevisionId?: string;
  /** Exact source hash already computed by a trusted caller. Supporting boundaries still verify the supplied bytes. */
  expectedSourceContentHash?: string;
  /**
   * Optional pre-activation fence used by trusted restore paths. Supporting
   * implementations must reject before replacing canonical content when the
   * parsed normalized body does not match this value.
   */
  expectedNormalizedTextHash?: string;
  /** Request-scoped only. Implementations must not persist or log this value. */
  archivePassword?: string;
}

export interface ImportResult {
  novel: Novel;
}

export interface ImportController {
  jobId: string;
  promise: Promise<ImportResult>;
  cancel(): void;
}

export interface ImportService {
  readonly supportsArchivePassword?: boolean;
  readonly supportsExpectedNormalizedTextHash?: boolean;
  readonly supportsExpectedSourceContentHash?: boolean;
  readonly supportsIncrementalImageSeriesAppend?: boolean;
  importFile(input: ImportFileInput, onProgress: (progress: ImportProgress) => void): ImportController;
}

export type ArchiveImportErrorCode = 'password_required' | 'wrong_password' | 'unsupported_archive';

export class ArchiveImportError extends Error {
  constructor(
    message: string,
    readonly code: ArchiveImportErrorCode,
  ) {
    super(message);
    this.name = 'ArchiveImportError';
  }
}

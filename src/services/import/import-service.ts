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

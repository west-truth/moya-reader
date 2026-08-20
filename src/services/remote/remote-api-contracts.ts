import type { ChapterSplitMode } from '../../domain/types';

export interface RemoteRequest {
  <T>(path: string, init?: RequestInit): Promise<T>;
}

export interface RemoteMutationResult {
  ok: true;
  applied: boolean;
}

export interface RemoteUploadStatus {
  uploadId: string;
  fileName?: string;
  sizeBytes: number;
  chapterSplitMode?: ChapterSplitMode;
  status: string;
  totalChunks?: number | null;
  expectedBytes: number;
  expectedChunks: number;
  uploadedBytes: number;
  receivedChunkIndexes: number[];
  missingChunkIndexes: number[];
  complete: boolean;
  importJobId?: string;
  importJobStatus?: string;
  importJobStage?: string;
  /** SHA-256 of the exact source bytes, used to prevent unsafe upload resume. */
  sourceContentHash?: string;
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class RemoteApiRequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`The server did not respond within ${timeoutMs} ms.`);
    this.name = 'RemoteApiRequestTimeoutError';
  }
}

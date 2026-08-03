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
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

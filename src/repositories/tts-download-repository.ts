import type { TTSDownloadItem, TTSDownloadJob, TTSDownloadPolicy } from '../domain/types';

export interface CreateTTSDownloadJobInput {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterIds: readonly string[];
  readonly wholeBook: boolean;
  readonly policy?: Partial<TTSDownloadPolicy>;
}

export interface PlanTTSDownloadItemInput {
  readonly chapterId: string;
  readonly paragraphId?: string;
  readonly cacheKey: string;
  readonly renderSpecHash: string;
}

export interface CompleteTTSDownloadItemInput {
  readonly cacheKey: string;
  readonly byteSize: number;
  readonly storage?: 'native' | 'indexeddb';
}

export interface TTSDownloadCacheEvidence extends CompleteTTSDownloadItemInput {
  readonly renderSpecHash: string;
}

export interface TTSDownloadRepository {
  create(input: CreateTTSDownloadJobInput): Promise<TTSDownloadJob>;
  get(id: string): Promise<TTSDownloadJob | undefined>;
  latestForBook(bookId: string): Promise<TTSDownloadJob | undefined>;
  listItems(jobId: string): Promise<TTSDownloadItem[]>;
  planItems(jobId: string, items: readonly PlanTTSDownloadItemInput[]): Promise<void>;
  markItemRunning(jobId: string, renderSpecHash: string): Promise<void>;
  markItemRetryWait(jobId: string, renderSpecHash: string, errorMessage: string, nextAttemptAt: string): Promise<void>;
  markItemReady(jobId: string, renderSpecHash: string, input: CompleteTTSDownloadItemInput): Promise<void>;
  markItemFailed(jobId: string, renderSpecHash: string, errorMessage: string): Promise<void>;
  finish(jobId: string, state?: TTSDownloadJob['state']): Promise<TTSDownloadJob | undefined>;
  cancel(jobId: string): Promise<TTSDownloadJob | undefined>;
  interruptedRenderSpecHashes(): Promise<string[]>;
  recoverInterrupted(evidence?: readonly TTSDownloadCacheEvidence[]): Promise<number>;
  protectedCacheKeys(): Promise<string[]>;
}

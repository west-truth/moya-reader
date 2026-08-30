export interface SaveImportedNovelProgress {
  phase: 'writing_pages' | 'activating_revision';
  chaptersWritten: number;
  pagesWritten: number;
  paragraphsWritten: number;
  totalChapters: number;
  totalPages: number;
  totalParagraphs: number;
}

export interface SaveImportedNovelOptions {
  batchPageCount?: number;
  /**
   * Allows an append-only document-series import to reuse the active content
   * revision. The storage layer still verifies that every existing chapter is
   * an unchanged prefix before selecting the incremental path.
   */
  allowAppendDelta?: boolean;
  /** Reject staging when the aggregate used to build this import is no longer active. */
  expectedBaseActiveContentRevisionId?: string;
  /** Keep the active archive cover and other embedded assets during an aggregate append. */
  preserveExistingEmbeddedAssets?: boolean;
  /** Keep only the active cover while replacing obsolete embedded document resources. */
  preserveExistingCover?: boolean;
  onProgress?: (progress: SaveImportedNovelProgress) => void | Promise<void>;
  shouldCancel?: () => boolean;
  sourceAsset?: {
    blob: Blob;
    fileName: string;
    contentType: string;
    contentHash: string;
    encoding?: import('../domain/types').EncodingMode;
    provenance?: 'original' | 'canonical_reconstruction';
  };
  extendReaderPlan?: (
    plan: import('./content-revision-store').ContentActivationReaderPlan,
  ) => import('./content-revision-store').ContentActivationReaderPlan;
}

export function throwIfImportCancelled(options: SaveImportedNovelOptions): void {
  if (options.shouldCancel?.()) throw new DOMException('Import cancelled', 'AbortError');
}

export async function withImportProgressHeartbeat<T>(
  report: SaveImportedNovelOptions['onProgress'],
  progress: SaveImportedNovelProgress,
  work: () => Promise<T>,
  shouldCancel?: () => boolean,
  intervalMs = 5_000,
): Promise<T> {
  await report?.(progress);
  if (shouldCancel) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (shouldCancel()) throw new DOMException('Import cancelled', 'AbortError');
  }
  const heartbeat = report
    ? setInterval(() => {
        void Promise.resolve(report(progress)).catch(() => undefined);
      }, intervalMs)
    : undefined;
  try {
    return await work();
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}

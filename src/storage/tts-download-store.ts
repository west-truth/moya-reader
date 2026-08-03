import type { TTSDownloadItem, TTSDownloadJob, TTSDownloadPolicy, TTSOfflineCacheManifestEntry } from '../domain/types';
import type {
  CompleteTTSDownloadItemInput,
  CreateTTSDownloadJobInput,
  PlanTTSDownloadItemInput,
  TTSDownloadRepository,
  TTSDownloadCacheEvidence,
} from '../repositories/tts-download-repository';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { getAllByIndex, getAllRecords, getItem, requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

const DEFAULT_POLICY: TTSDownloadPolicy = {
  network: 'unmetered',
  charging: 'any',
  retryLimit: 3,
  retainUntil: 'space_needed',
};

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function itemId(jobId: string, renderSpecHash: string): string {
  return `${jobId}:${renderSpecHash}`;
}

async function recomputeJob(jobId: string, forcedState?: TTSDownloadJob['state']): Promise<TTSDownloadJob | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [DOCUMENT_LISTENING_STORES.ttsDownloadJobs, DOCUMENT_LISTENING_STORES.ttsDownloadItems],
    'readwrite',
  );
  const jobs = tx.objectStore(DOCUMENT_LISTENING_STORES.ttsDownloadJobs);
  const items = tx.objectStore(DOCUMENT_LISTENING_STORES.ttsDownloadItems);
  const job = await requestToPromise<TTSDownloadJob | undefined>(jobs.get(jobId));
  if (!job) {
    tx.abort();
    return undefined;
  }
  const rows = await requestToPromise<TTSDownloadItem[]>(items.index('jobId').getAll(jobId));
  const readyItems = rows.filter((row) => row.state === 'ready').length;
  const failedItems = rows.filter((row) => row.state === 'failed').length;
  const byteSize = rows.reduce((total, row) => total + row.byteSize, 0);
  const next: TTSDownloadJob = {
    ...job,
    plannedItems: rows.length,
    readyItems,
    failedItems,
    byteSize,
    state:
      forcedState ??
      (rows.length > 0 && readyItems === rows.length
        ? 'completed'
        : readyItems > 0
          ? 'partial'
          : failedItems > 0
            ? 'failed'
            : job.state),
    updatedAt: nowIso(),
  };
  jobs.put(next);
  await transactionDone(tx);
  return next;
}

export async function createTTSDownloadJob(input: CreateTTSDownloadJobInput): Promise<TTSDownloadJob> {
  const chapterIds = [...new Set(input.chapterIds)];
  const job: TTSDownloadJob = {
    id: id('tts_download'),
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    scope: input.wholeBook ? { kind: 'book' } : { kind: 'chapter', chapterIds },
    state: 'planned',
    plannedItems: 0,
    readyItems: 0,
    failedItems: 0,
    byteSize: 0,
    policy: { ...DEFAULT_POLICY, ...input.policy },
    updatedAt: nowIso(),
  };
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsDownloadJobs, 'readwrite');
  tx.objectStore(DOCUMENT_LISTENING_STORES.ttsDownloadJobs).put(job);
  await transactionDone(tx);
  return job;
}

export async function planTTSDownloadItems(jobId: string, input: readonly PlanTTSDownloadItemInput[]): Promise<void> {
  if (input.length === 0) return;
  const job = await getItem<TTSDownloadJob>(DOCUMENT_LISTENING_STORES.ttsDownloadJobs, jobId);
  if (!job) throw new Error('TTS download job was not found.');
  const db = await openReaderDb();
  const tx = db.transaction(
    [DOCUMENT_LISTENING_STORES.ttsDownloadJobs, DOCUMENT_LISTENING_STORES.ttsDownloadItems],
    'readwrite',
  );
  const store = tx.objectStore(DOCUMENT_LISTENING_STORES.ttsDownloadItems);
  const updatedAt = nowIso();
  for (const candidate of input) {
    const rowId = itemId(jobId, candidate.renderSpecHash);
    const previous = await requestToPromise<TTSDownloadItem | undefined>(store.get(rowId));
    store.put({
      id: rowId,
      jobId,
      bookId: job.bookId,
      chapterId: candidate.chapterId,
      paragraphId: candidate.paragraphId,
      cacheKey: candidate.cacheKey,
      renderSpecHash: candidate.renderSpecHash,
      state: previous?.state === 'ready' ? 'ready' : 'planned',
      byteSize: previous?.byteSize ?? 0,
      attempts: previous?.attempts ?? 0,
      updatedAt,
    } satisfies TTSDownloadItem);
  }
  tx.objectStore(DOCUMENT_LISTENING_STORES.ttsDownloadJobs).put({ ...job, state: 'running', updatedAt });
  await transactionDone(tx);
  await recomputeJob(jobId, 'running');
}

async function updateItem(
  jobId: string,
  renderSpecHash: string,
  update: (item: TTSDownloadItem) => TTSDownloadItem,
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsDownloadItems, 'readwrite');
  const store = tx.objectStore(DOCUMENT_LISTENING_STORES.ttsDownloadItems);
  const current = await requestToPromise<TTSDownloadItem | undefined>(store.get(itemId(jobId, renderSpecHash)));
  if (current) store.put(update(current));
  await transactionDone(tx);
}

export async function markTTSDownloadItemRunning(jobId: string, renderSpecHash: string): Promise<void> {
  await updateItem(jobId, renderSpecHash, (item) => ({
    ...item,
    state: 'running',
    attempts: item.attempts + 1,
    errorMessage: undefined,
    nextAttemptAt: undefined,
    updatedAt: nowIso(),
  }));
}

export async function markTTSDownloadItemRetryWait(
  jobId: string,
  renderSpecHash: string,
  errorMessage: string,
  nextAttemptAt: string,
): Promise<void> {
  await updateItem(jobId, renderSpecHash, (item) => ({
    ...item,
    state: 'retry_wait',
    errorMessage: errorMessage.slice(0, 500),
    nextAttemptAt,
    updatedAt: nowIso(),
  }));
}

export async function markTTSDownloadItemReady(
  jobId: string,
  renderSpecHash: string,
  input: CompleteTTSDownloadItemInput,
): Promise<void> {
  let readyItem: TTSDownloadItem | undefined;
  await updateItem(jobId, renderSpecHash, (item) => {
    readyItem = {
      ...item,
      cacheKey: input.cacheKey,
      state: 'ready',
      byteSize: Math.max(0, input.byteSize),
      errorMessage: undefined,
      nextAttemptAt: undefined,
      updatedAt: nowIso(),
    };
    return readyItem;
  });
  if (readyItem) {
    const job = await getItem<TTSDownloadJob>(DOCUMENT_LISTENING_STORES.ttsDownloadJobs, jobId);
    if (job) {
      const timestamp = nowIso();
      const manifest: TTSOfflineCacheManifestEntry = {
        id: input.cacheKey,
        bookId: readyItem.bookId,
        chapterId: readyItem.chapterId,
        cacheKey: input.cacheKey,
        renderSpecHash,
        contentRevisionId: job.contentRevisionId,
        byteSize: Math.max(0, input.byteSize),
        storage: input.storage ?? 'native',
        pinnedByJobIds: job.policy.retainUntil === 'space_needed' ? [] : [jobId],
        createdAt: timestamp,
        lastAccessedAt: timestamp,
      };
      const db = await openReaderDb();
      const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readwrite');
      tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).put(manifest);
      await transactionDone(tx);
    }
  }
  await recomputeJob(jobId, 'running');
}

export async function markTTSDownloadItemFailed(
  jobId: string,
  renderSpecHash: string,
  errorMessage: string,
): Promise<void> {
  await updateItem(jobId, renderSpecHash, (item) => ({
    ...item,
    state: 'failed',
    errorMessage: errorMessage.slice(0, 500),
    nextAttemptAt: undefined,
    updatedAt: nowIso(),
  }));
  await recomputeJob(jobId, 'running');
}

export class IndexedDbTTSDownloadRepository implements TTSDownloadRepository {
  create(input: CreateTTSDownloadJobInput): Promise<TTSDownloadJob> {
    return createTTSDownloadJob(input);
  }
  get(id: string): Promise<TTSDownloadJob | undefined> {
    return getItem(DOCUMENT_LISTENING_STORES.ttsDownloadJobs, id);
  }
  async latestForBook(bookId: string): Promise<TTSDownloadJob | undefined> {
    const jobs = await getAllByIndex<TTSDownloadJob>(DOCUMENT_LISTENING_STORES.ttsDownloadJobs, 'bookId', bookId);
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }
  async latestForBookRevision(bookId: string, contentRevisionId: string): Promise<TTSDownloadJob | undefined> {
    const jobs = await getAllByIndex<TTSDownloadJob>(DOCUMENT_LISTENING_STORES.ttsDownloadJobs, 'bookId', bookId);
    return jobs
      .filter((job) => job.contentRevisionId === contentRevisionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }
  listItems(jobId: string): Promise<TTSDownloadItem[]> {
    return getAllByIndex(DOCUMENT_LISTENING_STORES.ttsDownloadItems, 'jobId', jobId);
  }
  planItems(jobId: string, items: readonly PlanTTSDownloadItemInput[]): Promise<void> {
    return planTTSDownloadItems(jobId, items);
  }
  markItemRunning(jobId: string, renderSpecHash: string): Promise<void> {
    return markTTSDownloadItemRunning(jobId, renderSpecHash);
  }
  markItemRetryWait(jobId: string, renderSpecHash: string, errorMessage: string, nextAttemptAt: string): Promise<void> {
    return markTTSDownloadItemRetryWait(jobId, renderSpecHash, errorMessage, nextAttemptAt);
  }
  markItemReady(jobId: string, renderSpecHash: string, input: CompleteTTSDownloadItemInput): Promise<void> {
    return markTTSDownloadItemReady(jobId, renderSpecHash, input);
  }
  markItemFailed(jobId: string, renderSpecHash: string, errorMessage: string): Promise<void> {
    return markTTSDownloadItemFailed(jobId, renderSpecHash, errorMessage);
  }
  finish(jobId: string, state?: TTSDownloadJob['state']): Promise<TTSDownloadJob | undefined> {
    return recomputeJob(jobId, state);
  }
  cancel(jobId: string): Promise<TTSDownloadJob | undefined> {
    return recomputeJob(jobId, 'cancelled');
  }
  async interruptedRenderSpecHashes(): Promise<string[]> {
    const jobs = (await getAllRecords<TTSDownloadJob>(DOCUMENT_LISTENING_STORES.ttsDownloadJobs)).filter(
      (job) => job.state === 'running',
    );
    const hashes = new Set<string>();
    for (const job of jobs) {
      for (const item of await this.listItems(job.id)) {
        if (item.state === 'planned' || item.state === 'running' || item.state === 'retry_wait') {
          hashes.add(item.renderSpecHash);
        }
      }
    }
    return [...hashes].sort();
  }
  async recoverInterrupted(evidence: readonly TTSDownloadCacheEvidence[] = []): Promise<number> {
    const readyByRenderHash = new Map(evidence.map((item) => [item.renderSpecHash, item]));
    const jobs = (await getAllRecords<TTSDownloadJob>(DOCUMENT_LISTENING_STORES.ttsDownloadJobs)).filter(
      (job) => job.state === 'running',
    );
    let recovered = 0;
    for (const job of jobs) {
      const rows = await this.listItems(job.id);
      for (const item of rows) {
        if (item.state !== 'planned' && item.state !== 'running' && item.state !== 'retry_wait') continue;
        const ready = readyByRenderHash.get(item.renderSpecHash);
        if (ready) {
          await markTTSDownloadItemReady(job.id, item.renderSpecHash, ready);
        } else {
          await markTTSDownloadItemFailed(
            job.id,
            item.renderSpecHash,
            '앱이 종료되어 오프라인 음성 준비가 중단되었습니다.',
          );
        }
      }
      await recomputeJob(job.id);
      recovered += 1;
    }
    return recovered;
  }
  async protectedCacheKeys(): Promise<string[]> {
    const entries = await getAllRecords<TTSOfflineCacheManifestEntry>(
      DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest,
    );
    return entries.filter((entry) => entry.pinnedByJobIds.length > 0).map((entry) => entry.cacheKey);
  }
}

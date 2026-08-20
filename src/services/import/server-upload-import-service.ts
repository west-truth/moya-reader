import { stableId } from '../../domain/hash';
import {
  mapServerBook,
  mapServerReadingPosition,
  RemoteApiClient,
  RemoteApiError,
  RemoteUploadStatus,
} from '../remote/remote-api-client';
import { hashBlobInChunks } from './chunked-file-reader';
import { ImportController, ImportFileInput, ImportProgress, ImportResult, ImportService } from './import-service';

export const DEFAULT_SERVER_UPLOAD_CHUNK_BYTES = 512 * 1024;
export const DEFAULT_SERVER_IMPORT_ACTIVITY_TIMEOUT_MS = 90_000;
export const DEFAULT_SERVER_IMPORT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_CHUNK_RETRIES = 3;
const IMPORT_JOB_POLL_INTERVAL_MS = 700;
const UPLOAD_SESSION_PREFIX = 'noveldesk.remoteUploadSession.';
const MAX_STORED_UPLOAD_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type RemoteImportJob = Awaited<ReturnType<RemoteApiClient['getImportJob']>>;

export class ServerImportActivityTimeoutError extends Error {
  constructor() {
    super('서버 가져오기 작업이 응답하지 않습니다. worker 상태를 확인한 뒤 같은 파일을 다시 선택해 이어서 진행하세요.');
    this.name = 'ServerImportActivityTimeoutError';
  }
}

export class ServerImportResponseTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`서버 가져오기 상태 요청이 ${timeoutMs}ms 안에 응답하지 않았습니다. 네트워크와 서버 상태를 확인해 주세요.`);
    this.name = 'ServerImportResponseTimeoutError';
  }
}

export class ServerImportCancelledError extends Error {
  constructor() {
    super('서버 가져오기 작업이 취소되었습니다.');
    this.name = 'ServerImportCancelledError';
  }
}

export interface StoredUploadSession {
  uploadId: string;
  fileName: string;
  sizeBytes: number;
  lastModified: number;
  encoding: ImportFileInput['encoding'];
  chapterSplitMode?: NonNullable<ImportFileInput['chapterSplitMode']>;
  clientBookId?: string;
  chunkBytes: number;
  totalChunks: number;
  sourceContentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredUploadSessionEntry extends StoredUploadSession {
  key: string;
  expiresAt: string;
}

export interface RemoteUploadSessionStore {
  read(key: string): StoredUploadSession | undefined;
  write(key: string, session: StoredUploadSession): void;
  remove(key: string): void;
  list?(): StoredUploadSessionEntry[];
}

const importStages: ImportProgress['status'][] = [
  'queued',
  'reading',
  'decoding',
  'splitting_chapters',
  'writing',
  'ready',
  'failed',
];

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function importStatus(job: RemoteImportJob): ImportProgress['status'] {
  if (job.status === 'failed') return 'failed';
  if (job.status === 'cancelled' || job.stage === 'cancelled') return 'cancelling';
  if (job.status === 'done') return 'ready';
  if (job.stage && importStages.includes(job.stage)) return job.stage;
  return job.status === 'queued' ? 'queued' : 'writing';
}

function importProgressFromJob(localJobId: string, fileSize: number, job: RemoteImportJob): ImportProgress {
  return {
    jobId: localJobId,
    status: importStatus(job),
    bytesRead: numberValue(job.bytes_read, fileSize),
    totalBytes: numberValue(job.total_bytes, fileSize),
    chaptersDetected: numberValue(job.chapters_detected),
    paragraphsWritten: numberValue(job.paragraphs_written),
    message: job.message || job.error_message || '서버에서 책을 분석하고 있습니다.',
  };
}

function importJobActivityFingerprint(job: RemoteImportJob): string {
  return JSON.stringify([
    job.status,
    job.stage,
    job.bytes_read,
    job.total_bytes,
    job.chapters_detected,
    job.paragraphs_written,
    job.book_id,
    job.error_message,
  ]);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

function receivedChunks(status: RemoteUploadStatus | undefined): Set<number> {
  return new Set(status?.receivedChunkIndexes ?? []);
}

function chunkByteRange(fileSize: number, chunkBytes: number, chunkIndex: number): { start: number; end: number } {
  const start = chunkIndex * chunkBytes;
  const end = Math.min(fileSize, start + chunkBytes);
  return { start, end };
}

function fileLastModified(file: File): number {
  return typeof file.lastModified === 'number' ? file.lastModified : 0;
}

function uploadSessionKey(
  input: ImportFileInput,
  chunkBytes: number,
  totalChunks: number,
  sourceContentHash: string,
): string {
  const parts = [
    input.file.name,
    String(input.file.size),
    String(fileLastModified(input.file)),
    input.encoding,
    input.chapterSplitMode ?? 'auto',
    String(chunkBytes),
    String(totalChunks),
    sourceContentHash,
  ];
  if (input.clientBookId) parts.push(input.clientBookId);
  return parts.map((part) => encodeURIComponent(part)).join('|');
}

function uploadSessionExpiresAt(session: StoredUploadSession): string {
  const timestamp = Date.parse(session.updatedAt || session.createdAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + MAX_STORED_UPLOAD_SESSION_AGE_MS).toISOString()
    : session.updatedAt || session.createdAt;
}

class BrowserRemoteUploadSessionStore implements RemoteUploadSessionStore {
  read(key: string): StoredUploadSession | undefined {
    try {
      const raw = globalThis.localStorage?.getItem(`${UPLOAD_SESSION_PREFIX}${key}`);
      return raw ? (JSON.parse(raw) as StoredUploadSession) : undefined;
    } catch {
      return undefined;
    }
  }

  write(key: string, session: StoredUploadSession): void {
    try {
      globalThis.localStorage?.setItem(`${UPLOAD_SESSION_PREFIX}${key}`, JSON.stringify(session));
    } catch {
      // Import can still proceed without persistent resume metadata.
    }
  }

  remove(key: string): void {
    try {
      globalThis.localStorage?.removeItem(`${UPLOAD_SESSION_PREFIX}${key}`);
    } catch {
      // Ignore storage cleanup failures.
    }
  }

  list(): StoredUploadSessionEntry[] {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return [];
      const sessions: StoredUploadSessionEntry[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const storageKey = storage.key(index);
        if (!storageKey?.startsWith(UPLOAD_SESSION_PREFIX)) continue;
        const raw = storage.getItem(storageKey);
        if (!raw) continue;
        try {
          const session = JSON.parse(raw) as StoredUploadSession;
          sessions.push({
            ...session,
            key: storageKey.slice(UPLOAD_SESSION_PREFIX.length),
            expiresAt: uploadSessionExpiresAt(session),
          });
        } catch {
          // Ignore malformed session records; the next matching import will replace them.
        }
      }
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
}

export class ServerUploadImportService implements ImportService {
  constructor(
    private readonly client: RemoteApiClient,
    private readonly chunkBytes = DEFAULT_SERVER_UPLOAD_CHUNK_BYTES,
    private readonly chunkRetries = DEFAULT_CHUNK_RETRIES,
    private readonly uploadSessionStore: RemoteUploadSessionStore = new BrowserRemoteUploadSessionStore(),
    private readonly importActivityTimeoutMs = DEFAULT_SERVER_IMPORT_ACTIVITY_TIMEOUT_MS,
    private readonly importResponseTimeoutMs = DEFAULT_SERVER_IMPORT_RESPONSE_TIMEOUT_MS,
  ) {}

  importFile(input: ImportFileInput, onProgress: (progress: ImportProgress) => void): ImportController {
    const jobId = stableId('remote_import', `${input.file.name}:${input.file.size}:${Date.now()}`, 12);
    const controller = new AbortController();

    const promise = this.runImport(jobId, input, controller.signal, onProgress);
    return {
      jobId,
      promise,
      cancel: () => controller.abort(),
    };
  }

  listStoredUploadSessions(): StoredUploadSessionEntry[] {
    const sessions = this.uploadSessionStore.list?.() ?? [];
    return sessions
      .filter((session) => {
        const fresh = this.isStoredSessionFresh(session);
        if (!fresh) this.uploadSessionStore.remove(session.key);
        return fresh;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async forgetStoredUploadSession(key: string): Promise<void> {
    const session = this.uploadSessionStore.read(key);
    if (session) {
      await this.client.cancelUpload(session.uploadId).catch(() => undefined);
    }
    this.uploadSessionStore.remove(key);
  }

  private async runImport(
    localJobId: string,
    input: ImportFileInput,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ): Promise<ImportResult> {
    let uploadSession:
      { uploadId: string; sessionKey: string; status?: RemoteUploadStatus; importJobId?: string } | undefined;
    const totalChunks = Math.max(1, Math.ceil(input.file.size / this.chunkBytes));
    try {
      onProgress({
        jobId: localJobId,
        status: 'queued',
        bytesRead: 0,
        totalBytes: input.file.size,
        chaptersDetected: 0,
        paragraphsWritten: 0,
        message: '서버 업로드를 준비하고 있습니다.',
      });

      const sourceContentHash = await hashBlobInChunks(input.file, {
        shouldCancel: () => signal.aborted,
        onProgress: ({ bytesRead }) =>
          onProgress({
            jobId: localJobId,
            status: 'reading',
            bytesRead,
            totalBytes: input.file.size,
            chaptersDetected: 0,
            paragraphsWritten: 0,
            message: '재개 가능한 업로드를 위해 파일 무결성을 확인하고 있습니다.',
          }),
      });
      uploadSession = await this.prepareUploadSession(
        localJobId,
        input,
        totalChunks,
        sourceContentHash,
        signal,
        onProgress,
      );

      const job = uploadSession.importJobId
        ? { jobId: uploadSession.importJobId, statusUrl: `/api/import-jobs/${uploadSession.importJobId}` }
        : await this.uploadAndComplete(
            localJobId,
            input,
            uploadSession.uploadId,
            totalChunks,
            uploadSession.status,
            signal,
            onProgress,
          );
      onProgress({
        jobId: localJobId,
        status: 'writing',
        bytesRead: input.file.size,
        totalBytes: input.file.size,
        chaptersDetected: 0,
        paragraphsWritten: 0,
        message: '서버에서 책을 분석하고 있습니다.',
      });

      let lastActivityFingerprint: string | undefined;
      let lastActivityAt = Date.now();
      while (true) {
        if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
        const remoteJob = await this.getImportJobWithResponseTimeout(job.jobId, signal);
        const serverProgress = importProgressFromJob(localJobId, input.file.size, remoteJob);
        onProgress(serverProgress);
        if (remoteJob.status === 'cancelled' || remoteJob.stage === 'cancelled') {
          this.uploadSessionStore.remove(uploadSession.sessionKey);
          throw new ServerImportCancelledError();
        }
        if (remoteJob.status === 'failed') {
          this.uploadSessionStore.remove(uploadSession.sessionKey);
          throw new Error(remoteJob.error_message ?? '서버 가져오기에 실패했습니다.');
        }
        if (remoteJob.status === 'done' && remoteJob.book_id) {
          const manifest = await this.client.getBookManifest(remoteJob.book_id);
          onProgress({
            ...serverProgress,
            status: 'ready',
            message: serverProgress.message || '서버 가져오기가 완료되었습니다.',
          });
          this.uploadSessionStore.remove(uploadSession.sessionKey);
          return {
            novel: {
              ...mapServerBook(manifest.book),
              ...(() => {
                const position = mapServerReadingPosition(manifest.readingPosition);
                return position
                  ? {
                      lastReadChapterId: position.chapterId,
                      lastReadParagraphId: position.paragraphId,
                      lastReadOffset: position.scrollTop,
                      lastReadProgress: position.chapterProgress,
                    }
                  : {};
              })(),
            },
          };
        }
        const activityFingerprint = importJobActivityFingerprint(remoteJob);
        const now = Date.now();
        if (activityFingerprint !== lastActivityFingerprint) {
          lastActivityFingerprint = activityFingerprint;
          lastActivityAt = now;
        } else if (now - lastActivityAt >= Math.max(IMPORT_JOB_POLL_INTERVAL_MS, this.importActivityTimeoutMs)) {
          throw new ServerImportActivityTimeoutError();
        }
        await wait(Math.min(IMPORT_JOB_POLL_INTERVAL_MS, Math.max(1, this.importActivityTimeoutMs)));
      }
    } catch (error) {
      if (isAbortError(error) && uploadSession) {
        await this.client.cancelUpload(uploadSession.uploadId).catch(() => undefined);
        this.uploadSessionStore.remove(uploadSession.sessionKey);
      }
      throw error;
    }
  }

  private async uploadAndComplete(
    localJobId: string,
    input: ImportFileInput,
    uploadId: string,
    totalChunks: number,
    initialStatus: RemoteUploadStatus | undefined,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ): ReturnType<RemoteApiClient['completeUpload']> {
    let uploadStatus = initialStatus ?? (await this.client.getUpload(uploadId, signal));
    let uploadedBytes = numberValue(uploadStatus.uploadedBytes);
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
      if (receivedChunks(uploadStatus).has(chunkIndex)) {
        onProgress({
          jobId: localJobId,
          status: 'reading',
          bytesRead: uploadedBytes,
          totalBytes: input.file.size,
          chaptersDetected: 0,
          paragraphsWritten: 0,
          message: `서버 업로드 상태 확인 ${chunkIndex + 1}/${totalChunks}`,
        });
        continue;
      }
      uploadStatus = await this.uploadChunkWithResume(
        localJobId,
        input,
        uploadId,
        chunkIndex,
        totalChunks,
        uploadStatus,
        signal,
        onProgress,
      );
      uploadedBytes = numberValue(uploadStatus.uploadedBytes, uploadedBytes);
      onProgress({
        jobId: localJobId,
        status: 'reading',
        bytesRead: uploadedBytes,
        totalBytes: input.file.size,
        chaptersDetected: 0,
        paragraphsWritten: 0,
        message: `서버로 업로드 중 ${chunkIndex + 1}/${totalChunks}`,
      });
    }

    uploadStatus = await this.reconcileMissingChunks(
      localJobId,
      input,
      uploadId,
      totalChunks,
      await this.client.getUpload(uploadId, signal),
      signal,
      onProgress,
    );

    return this.completeUploadWithResume(localJobId, input, uploadId, totalChunks, uploadStatus, signal, onProgress);
  }

  private async prepareUploadSession(
    localJobId: string,
    input: ImportFileInput,
    totalChunks: number,
    sourceContentHash: string,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ): Promise<{ uploadId: string; sessionKey: string; status?: RemoteUploadStatus; importJobId?: string }> {
    const sessionKey = uploadSessionKey(input, this.chunkBytes, totalChunks, sourceContentHash);
    const stored = this.uploadSessionStore.read(sessionKey);

    if (stored) {
      if (!this.isStoredSessionFresh(stored)) {
        this.uploadSessionStore.remove(sessionKey);
      } else {
        try {
          const status = await this.client.getUpload(stored.uploadId, signal);
          if (this.canResumeStoredUpload(input, totalChunks, sourceContentHash, stored, status)) {
            this.uploadSessionStore.write(sessionKey, { ...stored, updatedAt: new Date().toISOString() });
            onProgress({
              jobId: localJobId,
              status: 'reading',
              bytesRead: numberValue(status.uploadedBytes),
              totalBytes: input.file.size,
              chaptersDetected: 0,
              paragraphsWritten: 0,
              message: '이전 서버 업로드를 이어서 진행합니다.',
            });
            return { uploadId: stored.uploadId, sessionKey, status };
          }
          if (this.canResumeImportJob(input, totalChunks, sourceContentHash, stored, status)) {
            this.uploadSessionStore.write(sessionKey, { ...stored, updatedAt: new Date().toISOString() });
            onProgress({
              jobId: localJobId,
              status: 'writing',
              bytesRead: input.file.size,
              totalBytes: input.file.size,
              chaptersDetected: 0,
              paragraphsWritten: 0,
              message: '서버 가져오기 작업을 이어서 확인합니다.',
            });
            return { uploadId: stored.uploadId, sessionKey, status, importJobId: status.importJobId };
          }
        } catch (error) {
          if (!(error instanceof RemoteApiError && error.status === 404)) throw error;
        }
        this.uploadSessionStore.remove(sessionKey);
      }
    }

    const upload = await this.client.initUpload(
      {
        fileName: input.file.name,
        sizeBytes: input.file.size,
        contentType: input.file.type || 'text/plain',
        encoding: input.encoding,
        chapterSplitMode: input.chapterSplitMode ?? 'auto',
        totalChunks,
        clientBookId: input.clientBookId,
        sourceContentHash,
      },
      signal,
    );
    const now = new Date().toISOString();
    this.uploadSessionStore.write(sessionKey, {
      uploadId: upload.uploadId,
      fileName: input.file.name,
      sizeBytes: input.file.size,
      lastModified: fileLastModified(input.file),
      encoding: input.encoding,
      chapterSplitMode: input.chapterSplitMode ?? 'auto',
      clientBookId: input.clientBookId,
      chunkBytes: this.chunkBytes,
      totalChunks,
      sourceContentHash,
      createdAt: now,
      updatedAt: now,
    });
    return { uploadId: upload.uploadId, sessionKey };
  }

  private canResumeStoredUpload(
    input: ImportFileInput,
    totalChunks: number,
    sourceContentHash: string,
    stored: StoredUploadSession,
    status: RemoteUploadStatus,
  ): boolean {
    return (
      status.status === 'uploading' &&
      status.uploadId === stored.uploadId &&
      stored.sourceContentHash === sourceContentHash &&
      status.sourceContentHash === sourceContentHash &&
      status.fileName === input.file.name &&
      status.expectedBytes === input.file.size &&
      status.expectedChunks === totalChunks &&
      (status.totalChunks === undefined || status.totalChunks === null || status.totalChunks === totalChunks)
    );
  }

  private canResumeImportJob(
    input: ImportFileInput,
    totalChunks: number,
    sourceContentHash: string,
    stored: StoredUploadSession,
    status: RemoteUploadStatus,
  ): status is RemoteUploadStatus & { importJobId: string } {
    return (
      status.status !== 'uploading' &&
      status.status !== 'cancelled' &&
      status.uploadId === stored.uploadId &&
      Boolean(status.importJobId) &&
      status.importJobStatus !== 'cancelled' &&
      status.importJobStage !== 'cancelled' &&
      stored.sourceContentHash === sourceContentHash &&
      status.sourceContentHash === sourceContentHash &&
      status.fileName === input.file.name &&
      status.expectedBytes === input.file.size &&
      status.expectedChunks === totalChunks &&
      (status.totalChunks === undefined || status.totalChunks === null || status.totalChunks === totalChunks)
    );
  }

  private isStoredSessionFresh(session: StoredUploadSession): boolean {
    const timestamp = Date.parse(session.updatedAt || session.createdAt);
    return Number.isFinite(timestamp) && Date.now() - timestamp <= MAX_STORED_UPLOAD_SESSION_AGE_MS;
  }

  private getImportJobWithResponseTimeout(jobId: string, signal: AbortSignal): Promise<RemoteImportJob> {
    if (signal.aborted) return Promise.reject(new DOMException('Import cancelled', 'AbortError'));
    const controller = new AbortController();
    const timeoutMs = Math.max(1, this.importResponseTimeoutMs);

    return new Promise<RemoteImportJob>((resolve, reject) => {
      let settled = false;
      const abortFromCaller = () => {
        controller.abort(signal.reason);
        finish(() => reject(new DOMException('Import cancelled', 'AbortError')));
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        signal.removeEventListener('abort', abortFromCaller);
        callback();
      };
      const timer = globalThis.setTimeout(() => {
        controller.abort();
        finish(() => reject(new ServerImportResponseTimeoutError(timeoutMs)));
      }, timeoutMs);
      signal.addEventListener('abort', abortFromCaller, { once: true });
      if (signal.aborted) {
        abortFromCaller();
        return;
      }
      void this.client.getImportJob(jobId, controller.signal).then(
        (job) => finish(() => resolve(job)),
        (error) => finish(() => reject(signal.aborted ? new DOMException('Import cancelled', 'AbortError') : error)),
      );
    });
  }

  private async uploadChunkWithResume(
    localJobId: string,
    input: ImportFileInput,
    uploadId: string,
    chunkIndex: number,
    totalChunks: number,
    previousStatus: RemoteUploadStatus | undefined,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ): Promise<RemoteUploadStatus> {
    if (previousStatus && receivedChunks(previousStatus).has(chunkIndex)) return previousStatus;
    const { start, end } = chunkByteRange(input.file.size, this.chunkBytes, chunkIndex);
    const chunk = input.file.slice(start, end);
    let lastError: unknown;
    const maxAttempts = Math.max(1, this.chunkRetries);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
      try {
        const chunkResult = await this.client.putUploadChunk(uploadId, chunkIndex, chunk, signal);
        return chunkResult.upload ?? (await this.client.getUpload(uploadId, signal));
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');

        const status = await this.client.getUpload(uploadId, signal).catch(() => undefined);
        if (status && receivedChunks(status).has(chunkIndex)) return status;

        onProgress({
          jobId: localJobId,
          status: 'reading',
          bytesRead: numberValue(status?.uploadedBytes, start),
          totalBytes: input.file.size,
          chaptersDetected: 0,
          paragraphsWritten: 0,
          message: `서버 업로드 재시도 중 ${chunkIndex + 1}/${totalChunks} (${attempt}/${maxAttempts})`,
        });
        if (attempt < maxAttempts) await wait(250 * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('서버 업로드 청크 전송에 실패했습니다.');
  }

  private async reconcileMissingChunks(
    localJobId: string,
    input: ImportFileInput,
    uploadId: string,
    totalChunks: number,
    status: RemoteUploadStatus,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ): Promise<RemoteUploadStatus> {
    let latestStatus = status;
    const attempted = new Set<number>();

    while (latestStatus.missingChunkIndexes.length > 0) {
      const missingChunkIndexes = latestStatus.missingChunkIndexes.filter((chunkIndex) => !attempted.has(chunkIndex));
      if (missingChunkIndexes.length === 0) break;

      for (const missingChunkIndex of missingChunkIndexes) {
        if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
        attempted.add(missingChunkIndex);
        latestStatus = await this.uploadChunkWithResume(
          localJobId,
          input,
          uploadId,
          missingChunkIndex,
          totalChunks,
          latestStatus,
          signal,
          onProgress,
        );
      }
      latestStatus = await this.client.getUpload(uploadId, signal);
    }

    return latestStatus;
  }

  private async completeUploadWithResume(
    localJobId: string,
    input: ImportFileInput,
    uploadId: string,
    totalChunks: number,
    uploadStatus: RemoteUploadStatus,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ): ReturnType<RemoteApiClient['completeUpload']> {
    try {
      return await this.client.completeUpload(uploadId, signal);
    } catch (error) {
      if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
      const status = await this.client.getUpload(uploadId, signal).catch(() => uploadStatus);
      if (status.status !== 'uploading' && status.importJobId) {
        return { jobId: status.importJobId, statusUrl: `/api/import-jobs/${status.importJobId}` };
      }
      if (status.missingChunkIndexes.length === 0) throw error;
      const reconciledStatus = await this.reconcileMissingChunks(
        localJobId,
        input,
        uploadId,
        totalChunks,
        status,
        signal,
        onProgress,
      );
      if (reconciledStatus.missingChunkIndexes.length > 0) throw error;
      return this.client.completeUpload(uploadId, signal);
    }
  }
}

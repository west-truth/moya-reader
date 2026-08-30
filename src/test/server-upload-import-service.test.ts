import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient, RemoteApiError, RemoteUploadStatus } from '../services/remote/remote-api-client';
import {
  DEFAULT_SERVER_UPLOAD_CHUNK_BYTES,
  DEFAULT_SERVER_UPLOAD_CONCURRENCY,
  RemoteUploadSessionStore,
  ServerImportActivityTimeoutError,
  ServerImportCancelledError,
  ServerImportResponseTimeoutError,
  ServerUploadImportService,
  StoredUploadSession,
  StoredUploadSessionEntry,
} from '../services/import/server-upload-import-service';

const now = '2026-07-05T00:00:00.000Z';
const sourceContentHash = 'sha256:bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721';

function uploadStatus(receivedChunkIndexes: number[], uploadedBytes: number): RemoteUploadStatus {
  const allChunks = [0, 1, 2];
  return {
    uploadId: 'upload_1',
    fileName: 'novel.txt',
    sizeBytes: 6,
    status: 'uploading',
    totalChunks: 3,
    expectedBytes: 6,
    expectedChunks: 3,
    uploadedBytes,
    receivedChunkIndexes,
    missingChunkIndexes: allChunks.filter((chunkIndex) => !receivedChunkIndexes.includes(chunkIndex)),
    complete: receivedChunkIndexes.length === allChunks.length,
    sourceContentHash,
  };
}

function importedBook() {
  return {
    book: {
      id: 'book_1',
      title: 'Remote Novel',
      source_file_name: 'novel.txt',
      source_encoding: 'utf-8',
      normalized_text_hash: 'book_hash',
      created_at: now,
      updated_at: now,
      total_chapters: 1,
      total_characters: 6,
      total_paragraphs: 3,
      cover_seed: 7,
      favorite: false,
    },
    readingPosition: null,
  };
}

function makeFile(): File {
  return new File(['abcdef'], 'novel.txt', { type: 'text/plain' });
}

function storedSession(uploadId = 'upload_1'): StoredUploadSession {
  return {
    uploadId,
    fileName: 'novel.txt',
    sizeBytes: 6,
    lastModified: fileLastModified(),
    encoding: 'utf-8',
    chunkBytes: 2,
    totalChunks: 3,
    sourceContentHash,
    createdAt: now,
    updatedAt: now,
  };
}

function fileLastModified(): number {
  return makeFile().lastModified;
}

describe('ServerUploadImportService', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-06T00:00:00.000Z').getTime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists fresh stored upload sessions and forgets selected sessions for the import UI', async () => {
    const freshSession: StoredUploadSessionEntry = {
      ...storedSession('upload_fresh'),
      key: 'fresh-key',
      expiresAt: '2026-07-12T00:00:00.000Z',
    };
    const expiredSession: StoredUploadSessionEntry = {
      ...storedSession('upload_expired'),
      key: 'expired-key',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-08T00:00:00.000Z',
    };
    const store: RemoteUploadSessionStore = {
      read: vi.fn((key: string) => (key === 'fresh-key' ? freshSession : undefined)),
      write: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => [expiredSession, freshSession]),
    };
    const client = { cancelUpload: vi.fn(async () => ({ ok: true as const })) };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    expect(service.listStoredUploadSessions()).toEqual([freshSession]);
    expect(store.remove).toHaveBeenCalledWith('expired-key');

    await service.forgetStoredUploadSession('fresh-key');
    expect(client.cancelUpload).toHaveBeenCalledWith('upload_fresh');
    expect(store.remove).toHaveBeenCalledWith('fresh-key');
  });

  it('uses 2 MiB chunks by default to reduce round trips below the configured proxy limit', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => {
        throw new Error('stop after initialization');
      }),
    };
    const file = {
      name: 'large.txt',
      size: DEFAULT_SERVER_UPLOAD_CHUNK_BYTES + 1,
      lastModified: 1,
      type: 'text/plain',
      slice: (start: number, end: number) => new Blob([new Uint8Array(Math.max(0, end - start))]),
    } as File;
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, undefined, 3, store);

    await expect(service.importFile({ file, encoding: 'utf-8' }, vi.fn()).promise).rejects.toThrow(
      'stop after initialization',
    );

    expect(client.initUpload).toHaveBeenCalledWith(
      expect.objectContaining({ totalChunks: 2, sizeBytes: DEFAULT_SERVER_UPLOAD_CHUNK_BYTES + 1 }),
      expect.any(AbortSignal),
    );
  });

  it('uploads large files with bounded concurrency while preserving every chunk', async () => {
    const file = new File(['abcdefghijkl'], 'large.cbz', { type: 'application/vnd.comicbook+zip' });
    const received = new Set<number>();
    let activeUploads = 0;
    let maxActiveUploads = 0;
    let chunkZeroAttempts = 0;
    let uploadStatusRequests = 0;
    const currentStatus = (): RemoteUploadStatus => ({
      uploadId: 'upload_1',
      fileName: file.name,
      sizeBytes: file.size,
      status: 'uploading',
      totalChunks: file.size,
      expectedBytes: file.size,
      expectedChunks: file.size,
      uploadedBytes: received.size,
      receivedChunkIndexes: [...received].sort((left, right) => left - right),
      missingChunkIndexes: Array.from({ length: file.size }, (_, index) => index).filter(
        (index) => !received.has(index),
      ),
      complete: received.size === file.size,
    });
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => {
        uploadStatusRequests += 1;
        if (uploadStatusRequests === 2) throw new Error('temporary upload status failure');
        return currentStatus();
      }),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number, chunk: Blob) => {
        activeUploads += 1;
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
        if (chunkIndex === 0) chunkZeroAttempts += 1;
        try {
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, chunkIndex === 0 && chunkZeroAttempts === 1 ? 20 : 5),
          );
          if (chunkIndex === 0 && chunkZeroAttempts === 1) throw new Error('temporary chunk failure');
          expect(await chunk.text()).toBe('abcdefghijkl'[chunkIndex]);
          received.add(chunkIndex);
          return { ok: true as const, upload: currentStatus() };
        } finally {
          activeUploads -= 1;
        }
      }),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: file.size,
        total_bytes: file.size,
        chapters_detected: 1,
        paragraphs_written: 1,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(
      client as unknown as RemoteApiClient,
      1,
      3,
      undefined,
      90_000,
      20_000,
      DEFAULT_SERVER_UPLOAD_CONCURRENCY,
    );
    const progress = vi.fn();

    await expect(service.importFile({ file, encoding: 'auto' }, progress).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(maxActiveUploads).toBe(DEFAULT_SERVER_UPLOAD_CONCURRENCY);
    expect(client.putUploadChunk.mock.calls.filter((call) => call[1] === 0)).toHaveLength(2);
    expect(new Set(client.putUploadChunk.mock.calls.map((call) => call[1]))).toEqual(
      new Set(Array.from({ length: file.size }, (_, index) => index)),
    );
    expect([...received].sort((left, right) => left - right)).toEqual(
      Array.from({ length: file.size }, (_, index) => index),
    );
    const uploadedByteProgress = progress.mock.calls
      .map(([detail]) => detail)
      .filter((detail) => detail.message.startsWith('서버로 업로드 중'))
      .map((detail) => detail.bytesRead);
    expect(uploadedByteProgress).toEqual([...uploadedByteProgress].sort((left, right) => left - right));
    expect(uploadedByteProgress.at(-1)).toBe(file.size);
  });

  it('resumes only missing chunks with bounded concurrency when four or more chunks remain', async () => {
    const file = new File(['abcdefgh'], 'resume.cbz', { type: 'application/vnd.comicbook+zip' });
    const resumeSourceHash = `sha256:${'a'.repeat(64)}`;
    const received = new Set([0, 2]);
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const currentStatus = (): RemoteUploadStatus => ({
      uploadId: 'upload_old',
      fileName: file.name,
      sizeBytes: file.size,
      status: 'uploading',
      totalChunks: file.size,
      expectedBytes: file.size,
      expectedChunks: file.size,
      uploadedBytes: received.size,
      receivedChunkIndexes: [...received].sort((left, right) => left - right),
      missingChunkIndexes: Array.from({ length: file.size }, (_, index) => index).filter(
        (index) => !received.has(index),
      ),
      complete: received.size === file.size,
      sourceContentHash: resumeSourceHash,
    });
    const resumeSession: StoredUploadSession = {
      uploadId: 'upload_old',
      fileName: file.name,
      sizeBytes: file.size,
      lastModified: file.lastModified,
      encoding: 'auto',
      chapterSplitMode: 'auto',
      chunkBytes: 1,
      totalChunks: file.size,
      sourceContentHash: resumeSourceHash,
      createdAt: now,
      updatedAt: now,
    };
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => resumeSession),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(),
      getUpload: vi.fn(async () => currentStatus()),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => {
        activeUploads += 1;
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
        received.add(chunkIndex);
        activeUploads -= 1;
        return { ok: true as const, upload: currentStatus() };
      }),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_old',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: file.size,
        total_bytes: file.size,
        chapters_detected: 1,
        paragraphs_written: 1,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(
      client as unknown as RemoteApiClient,
      1,
      3,
      store,
      90_000,
      20_000,
      DEFAULT_SERVER_UPLOAD_CONCURRENCY,
    );

    await expect(
      service.importFile({ file, encoding: 'auto', expectedSourceContentHash: resumeSourceHash }, vi.fn()).promise,
    ).resolves.toMatchObject({ novel: expect.objectContaining({ id: 'book_1' }) });

    expect(client.initUpload).not.toHaveBeenCalled();
    expect(maxActiveUploads).toBe(DEFAULT_SERVER_UPLOAD_CONCURRENCY);
    expect(client.putUploadChunk.mock.calls.map((call) => call[1]).sort((left, right) => left - right)).toEqual([
      1, 3, 4, 5, 6, 7,
    ]);
    expect([...received].sort((left, right) => left - right)).toEqual(
      Array.from({ length: file.size }, (_, index) => index),
    );
  });

  it('aborts in-flight parallel chunks and does not schedule more chunks after cancellation', async () => {
    const file = new File(['abcdefghijkl'], 'large.cbz', { type: 'application/vnd.comicbook+zip' });
    const emptyStatus: RemoteUploadStatus = {
      uploadId: 'upload_1',
      fileName: file.name,
      sizeBytes: file.size,
      status: 'uploading',
      totalChunks: file.size,
      expectedBytes: file.size,
      expectedChunks: file.size,
      uploadedBytes: 0,
      receivedChunkIndexes: [],
      missingChunkIndexes: Array.from({ length: file.size }, (_, index) => index),
      complete: false,
    };
    let activeUploads = 0;
    let maxActiveUploads = 0;
    let abortedUploads = 0;
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => emptyStatus),
      putUploadChunk: vi.fn(async (_uploadId: string, _chunkIndex: number, _chunk: Blob, signal: AbortSignal) => {
        activeUploads += 1;
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              activeUploads -= 1;
              abortedUploads += 1;
              reject(new DOMException('Import cancelled', 'AbortError'));
            },
            { once: true },
          );
        });
        return { ok: true as const, upload: emptyStatus };
      }),
      completeUpload: vi.fn(),
      cancelUpload: vi.fn(async () => ({ ok: true as const, cancellationState: 'cancelled' as const })),
    };
    const service = new ServerUploadImportService(
      client as unknown as RemoteApiClient,
      1,
      3,
      undefined,
      90_000,
      20_000,
      DEFAULT_SERVER_UPLOAD_CONCURRENCY,
    );
    const controller = service.importFile({ file, encoding: 'auto' }, vi.fn());

    await vi.waitFor(() => expect(client.putUploadChunk).toHaveBeenCalledTimes(DEFAULT_SERVER_UPLOAD_CONCURRENCY));
    controller.cancel();

    await expect(controller.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(maxActiveUploads).toBe(DEFAULT_SERVER_UPLOAD_CONCURRENCY);
    expect(client.putUploadChunk).toHaveBeenCalledTimes(DEFAULT_SERVER_UPLOAD_CONCURRENCY);
    expect(abortedUploads).toBe(DEFAULT_SERVER_UPLOAD_CONCURRENCY);
    expect(activeUploads).toBe(0);
    expect(client.completeUpload).not.toHaveBeenCalled();
    expect(client.cancelUpload).toHaveBeenCalledWith('upload_1');
  });

  it('passes a client book id through upload initialization and resume metadata', async () => {
    const oneChunkStatus: RemoteUploadStatus = {
      uploadId: 'upload_1',
      fileName: 'novel.txt',
      sizeBytes: 6,
      status: 'uploading',
      totalChunks: 1,
      expectedBytes: 6,
      expectedChunks: 1,
      uploadedBytes: 6,
      receivedChunkIndexes: [0],
      missingChunkIndexes: [],
      complete: true,
    };
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => oneChunkStatus),
      putUploadChunk: vi.fn(async () => ({ ok: true as const, upload: oneChunkStatus })),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        book_id: 'novel_local_attach',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 10, 3, store);

    await service.importFile(
      {
        file: makeFile(),
        encoding: 'utf-8',
        chapterSplitMode: 'mixed',
        clientBookId: 'novel_local_attach',
      },
      () => undefined,
    ).promise;

    expect(client.initUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        clientBookId: 'novel_local_attach',
        chapterSplitMode: 'mixed',
        totalChunks: 1,
        sourceContentHash,
      }),
      expect.any(AbortSignal),
    );
    expect(store.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        uploadId: 'upload_1',
        chapterSplitMode: 'mixed',
        clientBookId: 'novel_local_attach',
        sourceContentHash,
      }),
    );
  });

  it('cancels the server upload and clears resume metadata when an active upload is aborted', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async (_uploadId: string, signal: AbortSignal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Import cancelled', 'AbortError')), {
            once: true,
          });
        });
        return uploadStatus([], 0);
      }),
      putUploadChunk: vi.fn(),
      completeUpload: vi.fn(),
      getImportJob: vi.fn(),
      getBookManifest: vi.fn(),
      cancelUpload: vi.fn(async () => ({ ok: true as const })),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);
    const controller = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn());

    await vi.waitFor(() => expect(client.getUpload).toHaveBeenCalled());
    controller.cancel();

    await expect(controller.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.cancelUpload).toHaveBeenCalledWith('upload_1');
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
    expect(client.putUploadChunk).not.toHaveBeenCalled();
    expect(client.completeUpload).not.toHaveBeenCalled();
  });

  it('cancels a server job when abort races with a committed upload completion response', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => uploadStatus([0, 1, 2], 6)),
      putUploadChunk: vi.fn(),
      completeUpload: vi.fn(async (_uploadId: string, signal: AbortSignal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Import cancelled', 'AbortError')), {
            once: true,
          });
        });
        return { jobId: 'job_committed', statusUrl: '/jobs/job_committed' };
      }),
      cancelUpload: vi.fn(async () => ({ ok: true as const, cancellationState: 'cancelled' as const })),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);
    const controller = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn());

    await vi.waitFor(() => expect(client.completeUpload).toHaveBeenCalled());
    controller.cancel();

    await expect(controller.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.cancelUpload).toHaveBeenCalledWith('upload_1');
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('requests cancellation and clears local resume metadata while the import job is processing', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => uploadStatus([0, 1, 2], 6)),
      putUploadChunk: vi.fn(),
      completeUpload: vi.fn(async () => ({ jobId: 'job_processing', statusUrl: '/jobs/job_processing' })),
      getImportJob: vi.fn(async (_jobId: string, signal: AbortSignal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Import cancelled', 'AbortError')), {
            once: true,
          });
        });
        throw new Error('unreachable');
      }),
      cancelUpload: vi.fn(async () => ({ ok: true as const, cancellationState: 'requested' as const })),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);
    const controller = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn());

    await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalled());
    controller.cancel();

    await expect(controller.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.cancelUpload).toHaveBeenCalledWith('upload_1');
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('uses upload status to avoid resending a chunk that reached the server before a failed response', async () => {
    let chunkOneFailed = false;
    const chunkPayloads: string[] = [];
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce(uploadStatus([], 0))
        .mockResolvedValueOnce(uploadStatus([0, 1], 4))
        .mockResolvedValueOnce(uploadStatus([0, 1, 2], 6)),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number, chunk: Blob) => {
        chunkPayloads.push(await chunk.text());
        if (chunkIndex === 1 && !chunkOneFailed) {
          chunkOneFailed = true;
          throw new Error('network lost after server write');
        }
        return {
          ok: true as const,
          upload: uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
        };
      }),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2);
    const progress = vi.fn();

    const result = await service.importFile({ file: makeFile(), encoding: 'utf-8' }, progress).promise;

    expect(result.novel).toMatchObject({ id: 'book_1', title: 'Remote Novel' });
    expect(client.getUpload).toHaveBeenCalledTimes(3);
    expect(client.putUploadChunk.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
    expect(chunkPayloads).toEqual(['ab', 'cd', 'ef']);
    expect(client.completeUpload).toHaveBeenCalledWith('upload_1', expect.any(AbortSignal));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('resumes an abandoned upload session when the same file is selected again', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce({ ...uploadStatus([0], 2), uploadId: 'upload_old' })
        .mockResolvedValueOnce({ ...uploadStatus([0, 1, 2], 6), uploadId: 'upload_old' }),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
        ok: true as const,
        upload: {
          ...uploadStatus(chunkIndex === 1 ? [0, 1] : [0, 1, 2], Math.min(6, (chunkIndex + 1) * 2)),
          uploadId: 'upload_old',
        },
      })),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_old',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);
    const progress = vi.fn();

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, progress).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(client.initUpload).not.toHaveBeenCalled();
    expect(client.putUploadChunk.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['upload_old', 1],
      ['upload_old', 2],
    ]);
    expect(client.completeUpload).toHaveBeenCalledWith('upload_old', expect.any(AbortSignal));
    expect(store.write).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uploadId: 'upload_old' }));
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ message: '이전 서버 업로드를 이어서 진행합니다.' }),
    );
  });

  it('does not mix files that share name, size, and mtime but have different source bytes', async () => {
    const oldFile = makeFile();
    const replacement = new File(['abcdeg'], 'novel.txt', {
      type: 'text/plain',
      lastModified: oldFile.lastModified,
    });
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      getUpload: vi
        .fn()
        .mockResolvedValueOnce({ ...uploadStatus([0], 2), uploadId: 'upload_old' })
        .mockRejectedValueOnce(new Error('stop after new initialization')),
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: replacement, encoding: 'utf-8' }, vi.fn()).promise).rejects.toThrow(
      'stop after new initialization',
    );

    expect(store.remove).toHaveBeenCalled();
    expect(client.initUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'novel.txt',
        sizeBytes: 6,
        sourceContentHash: expect.not.stringMatching(sourceContentHash),
      }),
      expect.any(AbortSignal),
    );
  });

  it('drops stale stored sessions and starts a new upload when the server session is no longer uploading', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce({ ...uploadStatus([0, 1, 2], 6), uploadId: 'upload_old', status: 'queued' })
        .mockResolvedValueOnce({ ...uploadStatus([], 0), uploadId: 'upload_new' })
        .mockResolvedValueOnce({ ...uploadStatus([0, 1, 2], 6), uploadId: 'upload_new' }),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
        ok: true as const,
        upload: {
          ...uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
          uploadId: 'upload_new',
        },
      })),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_new',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(store.remove).toHaveBeenCalled();
    expect(client.initUpload).toHaveBeenCalledTimes(1);
    expect(store.write).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uploadId: 'upload_new' }));
    expect(client.putUploadChunk.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['upload_new', 0],
      ['upload_new', 1],
      ['upload_new', 2],
    ]);
  });

  it('drops expired stored sessions before checking the old server upload', async () => {
    const expiredSession = {
      ...storedSession('upload_old'),
      updatedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => expiredSession),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce({ ...uploadStatus([], 0), uploadId: 'upload_new' })
        .mockResolvedValueOnce({ ...uploadStatus([0, 1, 2], 6), uploadId: 'upload_new' }),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
        ok: true as const,
        upload: {
          ...uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
          uploadId: 'upload_new',
        },
      })),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_new',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(store.remove).toHaveBeenCalled();
    expect(client.getUpload).not.toHaveBeenCalledWith('upload_old', expect.any(AbortSignal));
    expect(client.initUpload).toHaveBeenCalledTimes(1);
  });

  it('resumes an already queued import job instead of starting a duplicate upload', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(),
      getUpload: vi.fn(async () => ({
        ...uploadStatus([0, 1, 2], 6),
        uploadId: 'upload_old',
        status: 'queued',
        importJobId: 'job_existing',
        importJobStatus: 'queued',
        importJobStage: 'queued',
      })),
      putUploadChunk: vi.fn(),
      completeUpload: vi.fn(),
      getImportJob: vi.fn(async () => ({
        id: 'job_existing',
        upload_id: 'upload_old',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);
    const progress = vi.fn();

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, progress).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(client.initUpload).not.toHaveBeenCalled();
    expect(client.putUploadChunk).not.toHaveBeenCalled();
    expect(client.completeUpload).not.toHaveBeenCalled();
    expect(client.getImportJob).toHaveBeenCalledWith('job_existing', expect.any(AbortSignal));
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ message: '서버 가져오기 작업을 이어서 확인합니다.' }),
    );
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('terminates an externally cancelled resumed job immediately and clears resume metadata', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(),
      getUpload: vi.fn(async () => ({
        ...uploadStatus([0, 1, 2], 6),
        uploadId: 'upload_old',
        status: 'queued',
        importJobId: 'job_external',
        importJobStatus: 'processing',
        importJobStage: 'writing',
      })),
      getImportJob: vi.fn(async () => ({
        id: 'job_external',
        upload_id: 'upload_old',
        status: 'cancelled' as const,
        stage: 'cancelled' as const,
        message: 'cancelled elsewhere',
      })),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store, 90_000);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).rejects.toBeInstanceOf(
      ServerImportCancelledError,
    );

    expect(client.initUpload).not.toHaveBeenCalled();
    expect(client.getImportJob).toHaveBeenCalledTimes(1);
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it.each([
    { status: 'cancelled', importJobStatus: 'cancelled', importJobStage: 'cancelled' },
    { status: 'queued', importJobStatus: 'cancelled', importJobStage: 'writing' },
  ])('never resumes a terminal cancelled upload session %#', async (cancelledStatus) => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      getUpload: vi
        .fn()
        .mockResolvedValueOnce({
          ...uploadStatus([0, 1, 2], 6),
          uploadId: 'upload_old',
          importJobId: 'job_cancelled',
          ...cancelledStatus,
        })
        .mockRejectedValueOnce(new Error('stop after replacement initialization')),
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getImportJob: vi.fn(),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).rejects.toThrow(
      'stop after replacement initialization',
    );

    expect(store.remove).toHaveBeenCalled();
    expect(client.initUpload).toHaveBeenCalledTimes(1);
    expect(client.getImportJob).not.toHaveBeenCalled();
  });

  it('uses the import job from upload status when the complete response is lost after queueing', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce(uploadStatus([], 0))
        .mockResolvedValueOnce(uploadStatus([0, 1, 2], 6))
        .mockResolvedValueOnce({
          ...uploadStatus([0, 1, 2], 6),
          status: 'queued',
          importJobId: 'job_existing',
          importJobStatus: 'queued',
          importJobStage: 'queued',
        }),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
        ok: true as const,
        upload: uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
      })),
      completeUpload: vi.fn(async () => {
        throw new Error('response lost after queueing');
      }),
      getImportJob: vi.fn(async () => ({
        id: 'job_existing',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(client.completeUpload).toHaveBeenCalledTimes(1);
    expect(client.getImportJob).toHaveBeenCalledWith('job_existing', expect.any(AbortSignal));
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
  });

  it('keeps polling queued server import jobs until the server finishes', async () => {
    vi.useFakeTimers();
    try {
      const store: RemoteUploadSessionStore = {
        read: vi.fn(() => undefined),
        write: vi.fn(),
        remove: vi.fn(),
      };
      const client = {
        initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
        getUpload: vi.fn(async () => uploadStatus([0, 1, 2], 6)),
        putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
          ok: true as const,
          upload: uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
        })),
        completeUpload: vi.fn(async () => ({ jobId: 'job_slow', statusUrl: '/import-jobs/job_slow' })),
        getImportJob: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'job_slow',
            upload_id: 'upload_1',
            status: 'queued' as const,
            stage: 'queued' as const,
            bytes_read: 6,
            total_bytes: 6,
            chapters_detected: 0,
            paragraphs_written: 0,
            message: 'queued',
            book_id: null,
          })
          .mockResolvedValueOnce({
            id: 'job_slow',
            upload_id: 'upload_1',
            status: 'processing' as const,
            stage: 'writing' as const,
            bytes_read: 6,
            total_bytes: 6,
            chapters_detected: 1,
            paragraphs_written: 1,
            message: 'writing',
            book_id: null,
          })
          .mockResolvedValueOnce({
            id: 'job_slow',
            upload_id: 'upload_1',
            status: 'done' as const,
            stage: 'ready' as const,
            bytes_read: 6,
            total_bytes: 6,
            chapters_detected: 1,
            paragraphs_written: 3,
            message: 'done',
            book_id: 'book_1',
          }),
        getBookManifest: vi.fn(async () => importedBook()),
      };
      const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

      const importPromise = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise;
      await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(700);
      await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(700);

      await expect(importPromise).resolves.toMatchObject({
        novel: expect.objectContaining({ id: 'book_1' }),
      });
      expect(client.getImportJob).toHaveBeenCalledTimes(3);
      expect(store.remove).toHaveBeenCalledWith(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats changing asset progress messages as import activity', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ now: new Date('2026-08-21T00:00:00.000Z') });
    try {
      const store: RemoteUploadSessionStore = {
        read: vi.fn(() => undefined),
        write: vi.fn(),
        remove: vi.fn(),
      };
      const progressJob = (message: string) => ({
        id: 'job_assets',
        upload_id: 'upload_1',
        status: 'processing' as const,
        stage: 'writing' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 0,
        message,
        book_id: null,
      });
      const client = {
        initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
        getUpload: vi.fn(async () => uploadStatus([0, 1, 2], 6)),
        putUploadChunk: vi.fn(),
        completeUpload: vi.fn(async () => ({ jobId: 'job_assets', statusUrl: '/import-jobs/job_assets' })),
        getImportJob: vi
          .fn()
          .mockResolvedValueOnce(progressJob('EPUB 삽화와 표지를 저장하는 중입니다. 4 / 12개'))
          .mockResolvedValueOnce(progressJob('EPUB 삽화와 표지를 저장하는 중입니다. 8 / 12개'))
          .mockResolvedValueOnce(progressJob('EPUB 삽화와 표지를 저장하는 중입니다. 12 / 12개'))
          .mockResolvedValueOnce({
            ...progressJob('done'),
            status: 'done' as const,
            stage: 'ready' as const,
            paragraphs_written: 3,
            book_id: 'book_1',
          }),
        getBookManifest: vi.fn(async () => importedBook()),
      };
      const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store, 1_400);
      const importPromise = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise;

      await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(1));
      for (let poll = 2; poll <= 4; poll += 1) {
        await vi.advanceTimersByTimeAsync(700);
        await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(poll));
      }

      await expect(importPromise).resolves.toMatchObject({ novel: expect.objectContaining({ id: 'book_1' }) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling an import job that shows no activity and keeps its resumable session', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ now: new Date('2026-07-06T00:00:00.000Z') });
    try {
      const store: RemoteUploadSessionStore = {
        read: vi.fn(() => undefined),
        write: vi.fn(),
        remove: vi.fn(),
      };
      const client = {
        initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
        getUpload: vi.fn(async () => uploadStatus([0, 1, 2], 6)),
        putUploadChunk: vi.fn(),
        completeUpload: vi.fn(async () => ({ jobId: 'job_stalled', statusUrl: '/import-jobs/job_stalled' })),
        getImportJob: vi.fn(async () => ({
          id: 'job_stalled',
          upload_id: 'upload_1',
          status: 'queued' as const,
          stage: 'queued' as const,
          bytes_read: 6,
          total_bytes: 6,
          chapters_detected: 0,
          paragraphs_written: 0,
          message: 'queued',
          book_id: null,
          // Server heartbeats must not masquerade as actual import progress.
          updated_at: new Date(Date.now()).toISOString(),
        })),
        getBookManifest: vi.fn(),
      };
      const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store, 1_400);
      const importPromise = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise;
      const timeoutExpectation = expect(importPromise).rejects.toBeInstanceOf(ServerImportActivityTimeoutError);

      await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(700);
      await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(700);

      await timeoutExpectation;
      expect(client.getImportJob).toHaveBeenCalledTimes(3);
      expect(store.remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('separates an unanswered status request from a job with no progress', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ now: new Date('2026-07-06T00:00:00.000Z') });
    try {
      const store: RemoteUploadSessionStore = {
        read: vi.fn(() => undefined),
        write: vi.fn(),
        remove: vi.fn(),
      };
      const client = {
        initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
        getUpload: vi.fn(async () => uploadStatus([0, 1, 2], 6)),
        putUploadChunk: vi.fn(),
        completeUpload: vi.fn(async () => ({ jobId: 'job_unanswered', statusUrl: '/jobs/job_unanswered' })),
        getImportJob: vi.fn(() => new Promise(() => undefined)),
      };
      const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store, 90_000, 1_000);
      const importPromise = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise;
      const timeoutExpectation = expect(importPromise).rejects.toBeInstanceOf(ServerImportResponseTimeoutError);

      await vi.waitFor(() => expect(client.getImportJob).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await timeoutExpectation;
      expect(store.remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stored session when resume status lookup fails for a transient reason', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi.fn(async () => {
        throw new RemoteApiError('network unavailable', 503);
      }),
      putUploadChunk: vi.fn(),
      completeUpload: vi.fn(),
      getImportJob: vi.fn(),
      getBookManifest: vi.fn(),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).rejects.toThrow(
      'network unavailable',
    );

    expect(store.remove).not.toHaveBeenCalled();
    expect(client.initUpload).not.toHaveBeenCalled();
  });

  it('removes a stored session when the server reports it missing', async () => {
    const store: RemoteUploadSessionStore = {
      read: vi.fn(() => storedSession('upload_old')),
      write: vi.fn(),
      remove: vi.fn(),
    };
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_new', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockRejectedValueOnce(new RemoteApiError('not found', 404))
        .mockResolvedValueOnce({ ...uploadStatus([], 0), uploadId: 'upload_new' })
        .mockResolvedValueOnce({ ...uploadStatus([0, 1, 2], 6), uploadId: 'upload_new' }),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
        ok: true as const,
        upload: {
          ...uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
          uploadId: 'upload_new',
        },
      })),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_new',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(store.remove).toHaveBeenCalled();
    expect(client.initUpload).toHaveBeenCalledTimes(1);
  });

  it('retries a failed chunk when the status endpoint still reports it missing', async () => {
    let chunkOneAttempts = 0;
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce(uploadStatus([], 0))
        .mockResolvedValueOnce(uploadStatus([0], 2))
        .mockResolvedValueOnce(uploadStatus([0, 1, 2], 6)),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => {
        if (chunkIndex === 1) {
          chunkOneAttempts += 1;
          if (chunkOneAttempts === 1) throw new Error('transient network error');
        }
        const received =
          chunkIndex === 2 ? [0, 1, 2] : [...Array.from({ length: chunkIndex + 1 }, (_, index) => index)];
        return { ok: true as const, upload: uploadStatus(received, Math.min(6, (chunkIndex + 1) * 2)) };
      }),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 2);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(client.putUploadChunk.mock.calls.map((call) => call[1])).toEqual([0, 1, 1, 2]);
  });

  it('retries chunks reported missing by the final status check before completion', async () => {
    let chunkTwoAttempts = 0;
    const chunkPayloads: string[] = [];
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce(uploadStatus([], 0))
        .mockResolvedValueOnce(uploadStatus([0, 1], 4))
        .mockResolvedValueOnce(uploadStatus([0, 1, 2], 6)),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number, chunk: Blob) => {
        chunkPayloads.push(await chunk.text());
        if (chunkIndex === 2) {
          chunkTwoAttempts += 1;
          return {
            ok: true as const,
            upload: uploadStatus(chunkTwoAttempts === 1 ? [0, 1] : [0, 1, 2], chunkTwoAttempts === 1 ? 4 : 6),
          };
        }
        return {
          ok: true as const,
          upload: uploadStatus([...Array.from({ length: chunkIndex + 1 }, (_, index) => index)], (chunkIndex + 1) * 2),
        };
      }),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(client.putUploadChunk.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 2]);
    expect(chunkPayloads).toEqual(['ab', 'cd', 'ef', 'ef']);
    expect(client.completeUpload).toHaveBeenCalledTimes(1);
  });

  it('reconciles missing chunks once more when complete rejects an incomplete upload', async () => {
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce(uploadStatus([], 0))
        .mockResolvedValueOnce(uploadStatus([0, 1, 2], 6))
        .mockResolvedValueOnce(uploadStatus([0, 1], 4))
        .mockResolvedValueOnce(uploadStatus([0, 1, 2], 6)),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => ({
        ok: true as const,
        upload: uploadStatus(
          chunkIndex === 2 ? [0, 1, 2] : [...Array.from({ length: chunkIndex + 1 }, (_, index) => index)],
          Math.min(6, (chunkIndex + 1) * 2),
        ),
      })),
      completeUpload: vi
        .fn()
        .mockRejectedValueOnce(new Error('missing chunks'))
        .mockResolvedValueOnce({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' }),
      getImportJob: vi.fn(async () => ({
        id: 'job_1',
        upload_id: 'upload_1',
        status: 'done' as const,
        stage: 'ready' as const,
        bytes_read: 6,
        total_bytes: 6,
        chapters_detected: 1,
        paragraphs_written: 3,
        message: 'done',
        book_id: 'book_1',
      })),
      getBookManifest: vi.fn(async () => importedBook()),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).resolves.toMatchObject({
      novel: expect.objectContaining({ id: 'book_1' }),
    });

    expect(client.completeUpload).toHaveBeenCalledTimes(2);
    expect(client.putUploadChunk.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 2]);
  });

  it('does not complete the upload after chunk retry exhaustion', async () => {
    const client = {
      initUpload: vi.fn(async () => ({ uploadId: 'upload_1', chunkUrlTemplate: '/chunks/{chunkIndex}' })),
      getUpload: vi
        .fn()
        .mockResolvedValueOnce(uploadStatus([], 0))
        .mockResolvedValueOnce(uploadStatus([0], 2))
        .mockResolvedValueOnce(uploadStatus([0], 2)),
      putUploadChunk: vi.fn(async (_uploadId: string, chunkIndex: number) => {
        if (chunkIndex === 1) throw new Error('still offline');
        return { ok: true as const, upload: uploadStatus([0], 2) };
      }),
      completeUpload: vi.fn(async () => ({ jobId: 'job_1', statusUrl: '/import-jobs/job_1' })),
      getImportJob: vi.fn(),
      getBookManifest: vi.fn(),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 2);

    await expect(service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn()).promise).rejects.toThrow(
      'still offline',
    );

    expect(client.putUploadChunk.mock.calls.map((call) => call[1])).toEqual([0, 1, 1]);
    expect(client.completeUpload).not.toHaveBeenCalled();
  });
});

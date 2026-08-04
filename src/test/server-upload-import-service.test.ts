import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient, RemoteApiError, RemoteUploadStatus } from '../services/remote/remote-api-client';
import {
  RemoteUploadSessionStore,
  ServerUploadImportService,
  StoredUploadSession,
  StoredUploadSessionEntry,
} from '../services/import/server-upload-import-service';

const now = '2026-07-05T00:00:00.000Z';

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
      }),
      expect.any(AbortSignal),
    );
    expect(store.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        uploadId: 'upload_1',
        chapterSplitMode: 'mixed',
        clientBookId: 'novel_local_attach',
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
      getUpload: vi.fn(async () => uploadStatus([], 0)),
      putUploadChunk: vi.fn(),
      completeUpload: vi.fn(),
      getImportJob: vi.fn(),
      getBookManifest: vi.fn(),
      cancelUpload: vi.fn(async () => ({ ok: true as const })),
    };
    const service = new ServerUploadImportService(client as unknown as RemoteApiClient, 2, 3, store);
    const controller = service.importFile({ file: makeFile(), encoding: 'utf-8' }, vi.fn());

    controller.cancel();

    await expect(controller.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.cancelUpload).toHaveBeenCalledWith('upload_1');
    expect(store.remove).toHaveBeenCalledWith(expect.any(String));
    expect(client.putUploadChunk).not.toHaveBeenCalled();
    expect(client.completeUpload).not.toHaveBeenCalled();
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

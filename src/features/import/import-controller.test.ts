import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { ImportProgress, ImportResult, ImportService } from '../../services/import/import-service';
import { ImportRunCancellation, runImportBatch } from './import-controller';
import { completedImportNotice, isSupportedImportFile, selectSupportedImportFiles } from './import-notice-policy';

function novel(id: string, title = id): Novel {
  return {
    id,
    title,
    sourceFileName: `${id}.txt`,
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: `raw-${id}`,
    normalizedTextHash: `normalized-${id}`,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 2,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function file(name: string): File {
  return { name, size: 12, lastModified: 1, type: 'text/plain' } as File;
}

function progress(jobId: string): ImportProgress {
  return {
    jobId,
    status: 'writing',
    bytesRead: 12,
    totalBytes: 12,
    chaptersDetected: 1,
    paragraphsWritten: 1,
    message: '저장 중',
  };
}

describe('runImportBatch', () => {
  it('imports supported files sequentially and reports the stored last novel', async () => {
    const callOrder: string[] = [];
    const service: ImportService = {
      importFile(input, onProgress) {
        callOrder.push(input.file.name);
        onProgress(progress(input.file.name));
        return {
          jobId: input.file.name,
          promise: Promise.resolve({ novel: novel(input.file.name) }),
          cancel: vi.fn(),
        };
      },
    };
    const onBatchChange = vi.fn();
    const onProgress = vi.fn();

    const outcome = await runImportBatch(
      {
        files: [{ file: file('first.txt') }, { file: file('second.md') }],
        skipped: 1,
        encoding: 'auto',
        chapterSplitMode: 'auto',
        importService: service,
        getNovel: async (id) => novel(id, `저장됨 ${id}`),
      },
      new ImportRunCancellation(),
      { onBatchChange, onProgress, onFileFailed: vi.fn(), onCancelled: vi.fn() },
    );

    expect(callOrder).toEqual(['first.txt', 'second.md']);
    expect(outcome).toMatchObject({ completed: 2, failed: 0, skipped: 1, aborted: false });
    expect(outcome.lastImportedNovel?.title).toBe('저장됨 second.md');
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onBatchChange).toHaveBeenLastCalledWith(expect.objectContaining({ completed: 2, failed: 0 }));
  });

  it('keeps the batch moving after a file error', async () => {
    let callCount = 0;
    const service: ImportService = {
      importFile(input) {
        callCount += 1;
        const promise: Promise<ImportResult> =
          callCount === 1
            ? Promise.reject(new Error('decode failed'))
            : Promise.resolve({ novel: novel(input.file.name) });
        return { jobId: input.file.name, promise, cancel: vi.fn() };
      },
    };
    const onFileFailed = vi.fn();

    const outcome = await runImportBatch(
      {
        files: [{ file: file('broken.txt') }, { file: file('valid.txt') }],
        skipped: 0,
        encoding: 'auto',
        chapterSplitMode: 'mixed',
        importService: service,
        getNovel: async () => undefined,
      },
      new ImportRunCancellation(),
      { onBatchChange: vi.fn(), onProgress: vi.fn(), onFileFailed, onCancelled: vi.fn() },
    );

    expect(outcome).toMatchObject({ completed: 1, failed: 1, aborted: false });
    expect(onFileFailed).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'broken.txt' }),
      expect.objectContaining({ message: 'decode failed' }),
    );
  });

  it('cancels the active controller and stops the remaining queue', async () => {
    let rejectImport: ((error: Error) => void) | undefined;
    const cancel = vi.fn(() => rejectImport?.(new DOMException('Aborted', 'AbortError')));
    const service: ImportService = {
      importFile(input) {
        return {
          jobId: input.file.name,
          promise: new Promise<ImportResult>((_resolve, reject) => {
            rejectImport = reject;
          }),
          cancel,
        };
      },
    };
    const cancellation = new ImportRunCancellation();
    const onCancelled = vi.fn();
    const running = runImportBatch(
      {
        files: [{ file: file('first.txt') }, { file: file('never-started.txt') }],
        skipped: 0,
        encoding: 'auto',
        chapterSplitMode: 'single',
        importService: service,
        getNovel: async () => undefined,
      },
      cancellation,
      { onBatchChange: vi.fn(), onProgress: vi.fn(), onFileFailed: vi.fn(), onCancelled },
    );

    cancellation.cancel();
    const outcome = await running;

    expect(cancel).toHaveBeenCalledOnce();
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ completed: 0, failed: 0, aborted: true });
  });
});

describe('isSupportedImportFile', () => {
  it('supports reflowable and fixed-layout document extensions', () => {
    expect(isSupportedImportFile(file('book.txt'))).toBe(true);
    expect(isSupportedImportFile(file('book.MARKDOWN'))).toBe(true);
    expect(isSupportedImportFile(file('book.epub'))).toBe(true);
    expect(isSupportedImportFile(file('book.pdf'))).toBe(true);
    expect(isSupportedImportFile(file('book.zip'))).toBe(true);
    expect(isSupportedImportFile(file('book.cbr'))).toBe(true);
    expect(isSupportedImportFile(file('book.cb7'))).toBe(true);
    expect(isSupportedImportFile(file('book.CBZ'))).toBe(true);
    expect(isSupportedImportFile(file('book.rar'))).toBe(true);
  });

  it('keeps unsupported and successful import copy stable', () => {
    expect(selectSupportedImportFiles([file('book.exe')]).notice).toEqual({
      message:
        'TXT, Markdown, DRM 없는 EPUB, 문서 묶음 ZIP, PDF 또는 이미지 ZIP/CBZ/RAR/CBR/7z/CB7 파일을 선택해 주세요.',
      tone: 'warning',
    });
    expect(isSupportedImportFile(file('book.epub'))).toBe(true);
    expect(
      completedImportNotice(
        { completed: 1, failed: 0, skipped: 0, aborted: false, lastImportedNovel: novel('book', '테스트 책') },
        [file('book.txt')],
      ),
    ).toEqual({ message: '"테스트 책"을(를) 책장에 추가했습니다.', tone: 'success' });
  });
});

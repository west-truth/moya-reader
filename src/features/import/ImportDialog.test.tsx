import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ImportFeatureController } from './useImportController';
import { ImportDialog } from './ImportDialog';

function controller(overrides: Partial<ImportFeatureController> = {}): ImportFeatureController {
  return {
    isOpen: true,
    busy: false,
    pendingFiles: [],
    duplicateBusy: false,
    duplicateConflicts: [],
    encoding: 'auto',
    chapterSplitMode: 'auto',
    uploadSessions: [],
    usesPlatformPicker: false,
    supportsArchivePassword: true,
    archivePassword: '',
    libraryDrop: {
      active: false,
      actions: {
        enter: vi.fn(),
        over: vi.fn(),
        leave: vi.fn(),
        drop: vi.fn(),
        dropOnEmptyState: vi.fn(),
      },
    },
    open: vi.fn(),
    close: vi.fn(),
    selectFiles: vi.fn(),
    pickFiles: vi.fn(),
    importFiles: vi.fn(),
    startPendingImport: vi.fn(),
    previewPendingImport: vi.fn(),
    cancelImport: vi.fn(),
    setEncoding: vi.fn(),
    setChapterSplitMode: vi.fn(),
    setDuplicatePolicy: vi.fn(),
    setArchivePassword: vi.fn(),
    forgetUploadSession: vi.fn(),
    ...overrides,
  };
}

describe('ImportDialog', () => {
  it('preserves the import copy and accessible dialog/file controls', () => {
    const markup = renderToStaticMarkup(<ImportDialog controller={controller()} />);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('책 가져오기');
    expect(markup).toContain('텍스트, EPUB, PDF 또는 만화 압축 파일 선택');
    expect(markup).toContain(
      'accept=".txt,.md,.markdown,.epub,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,text/plain,application/epub+zip,application/pdf,application/zip,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-7z-compressed"',
    );
    expect(markup).toContain('중간부터 회차 표식이 바뀐 텍스트는 혼합 표식 강화');
    expect(markup).toMatch(/<label class="field-label" for="[^"]+">텍스트 인코딩<\/label><select id="[^"]+"/);
    expect(markup).toMatch(/<label class="field-label" for="[^"]+">텍스트 화 분리 방식<\/label><select id="[^"]+"/);
  });

  it('renders selected files, import progress, and resumable upload sessions', () => {
    const selectedFile = { name: '연재본.txt', size: 2048, lastModified: 1 } as File;
    const markup = renderToStaticMarkup(
      <ImportDialog
        controller={controller({
          busy: true,
          pendingFiles: [selectedFile],
          progress: {
            jobId: 'job-1',
            status: 'writing',
            bytesRead: 1024,
            totalBytes: 2048,
            chaptersDetected: 3,
            paragraphsWritten: 20,
            message: '책장에 저장하는 중입니다.',
          },
          batch: { total: 1, current: 1, completed: 0, failed: 0, skipped: 0, currentFileName: '연재본.txt' },
          uploadSessions: [
            {
              key: 'session-1',
              uploadId: 'upload-1',
              fileName: '중단본.txt',
              sizeBytes: 4096,
              lastModified: 1,
              encoding: 'utf-8',
              chapterSplitMode: 'mixed',
              chunkBytes: 1024,
              totalChunks: 4,
              createdAt: '2026-07-10T00:00:00.000Z',
              updatedAt: '2026-07-10T00:00:00.000Z',
              expiresAt: '2026-07-17T00:00:00.000Z',
            },
          ],
        })}
      />,
    );

    expect(markup).toContain('연재본.txt');
    expect(markup).toContain('책장에 저장하는 중입니다.');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('중단된 서버 업로드');
    expect(markup).toContain('중단본.txt');
  });
});

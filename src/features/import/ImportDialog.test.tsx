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
    seriesBusy: false,
    seriesTargetLocked: false,
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
    openChapterAppend: vi.fn(),
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
    setSeriesTargetNovel: vi.fn(),
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

  it('labels failed progress as a failure instead of an active import', () => {
    const markup = renderToStaticMarkup(
      <ImportDialog
        controller={controller({
          progress: {
            jobId: 'job-failed',
            status: 'failed',
            bytesRead: 0,
            totalBytes: 2048,
            chaptersDetected: 0,
            paragraphsWritten: 0,
            message: 'Bearer token을 다시 확인하세요.',
          },
        })}
      />,
    );

    expect(markup).toContain('가져오기 실패');
    expect(markup).not.toContain('가져오는 중');
  });

  it('shows a local series add/duplicate/conflict plan before import', () => {
    const file = new File(['chapter'], '서른의 봄 3화.cbz');
    const parsed = {
      original: file.name,
      displayBaseName: '서른의 봄 3화',
      workTitle: '서른의 봄',
      normalizedWorkKey: '서른의 봄',
      looseWorkKey: '서른의봄',
      releaseTitle: '3화',
      releaseKey: 'c:3',
      chapterNumber: 3,
      confidence: 'high' as const,
      evidence: ['chapter'],
    };
    const inspection = {
      sourceKind: 'nested_package' as const,
      workTitle: '서른의 봄',
      normalizedWorkKey: '서른의 봄',
      confidence: 'high' as const,
      releases: [
        {
          id: 'release-3',
          file,
          originalName: file.name,
          parsed,
          releaseKey: 'c:3',
          contentHash: 'hash-3',
          pageCount: 12,
        },
      ],
      candidateNovels: [],
      sourceFileNames: ['서른의 봄.zip'],
    };
    const markup = renderToStaticMarkup(
      <ImportDialog
        controller={controller({
          pendingFiles: [file],
          seriesInspection: inspection,
          seriesPlan: {
            inspection,
            releases: [{ ...inspection.releases[0], disposition: 'add' }],
            addCount: 1,
            duplicateCount: 2,
            conflictCount: 1,
          },
        })}
      />,
    );

    expect(markup).toContain('연재 작품으로 가져오기');
    expect(markup).toContain('새 회차 1개');
    expect(markup).toContain('중복 2개');
    expect(markup).toContain('충돌 1개');
    expect(markup).toContain('연재 작품 가져오기');
  });

  it('shows a TXT or EPUB chapter merge plan for a local Library work', () => {
    const file = new File(['제2화\n\n본문'], '작품 2화.txt', { type: 'text/plain' });
    const inspection = {
      workTitle: '작품',
      normalizedWorkKey: '작품',
      format: 'txt' as const,
      sources: [],
      chapters: [
        {
          id: 'chapter-2',
          sourceId: 'source-2',
          sourceTitle: '2화',
          sourceFileName: file.name,
          sourceChapterIndex: 1,
          title: '제2화',
          textHash: 'hash-2',
          characterCount: 2,
          paragraphCount: 1,
        },
      ],
      candidateNovels: [],
    };
    const markup = renderToStaticMarkup(
      <ImportDialog
        controller={controller({
          pendingFiles: [file],
          documentSeriesInspection: inspection,
          documentSeriesPlan: {
            inspection,
            targetChapters: [],
            chapters: [{ ...inspection.chapters[0], disposition: 'add' }],
            addCount: 1,
            duplicateCount: 0,
            conflictCount: 0,
          },
        })}
      />,
    );

    expect(markup).toContain('로컬 작품에 회차로 가져오기');
    expect(markup).toContain('선택한 원본은 그대로 보존');
    expect(markup).toContain('제2화');
    expect(markup).toContain('새 회차 1개');
  });
});

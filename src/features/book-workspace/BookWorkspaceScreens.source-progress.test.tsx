import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import type { Novel, ReaderSettings } from '../../domain/types';
import type { SourceTextReaderOptions } from '../external-sources/SourceTextStreamReader';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { LibraryManagementController } from '../library/useLibraryManagementController';
import type { BookEnrichmentController } from '../book-enrichment/useBookEnrichmentController';
import type { BookWorkspaceController } from './book-workspace-controller';
import { buildBookWorkspaceLibraryProjection } from './book-workspace-projection';
import type { BookWorkspaceProjection } from './book-workspace-projection';
import { BookWorkspaceScreens } from './BookWorkspaceScreens';
import { testNovel, testWorkspaceState } from './book-workspace-test-fixtures';

// Every downloaded chapter is read, but only 30 of the source's 120 releases.
const sourceBook = testNovel({
  id: 'source-book',
  title: '소스 작품',
  totalChapters: 30,
  lastReadProgress: 1,
  lastReadChapterIndex: 30,
  lastReadAt: '2026-09-02T00:00:00.000Z',
});

function render(
  settings: ReaderSettings,
  libraryBootstrap?: ExternalSourceController['libraryBootstrap'],
  otherBook?: Novel,
) {
  const state = testWorkspaceState({ view: 'library', novels: otherBook ? [sourceBook, otherBook] : [sourceBook] });
  const projection = buildBookWorkspaceLibraryProjection(state) as BookWorkspaceProjection;
  const externalSources = {
    sources: [],
    libraryWorks: [],
    libraryBootstrap,
    open: false,
    busy: false,
    sourceWorkProgress: {
      byNovelId: new Map([
        ['source-book', { readCount: 30, totalCount: 120, progress: 0.25, lastReadAt: '2026-09-25T00:00:00.000Z' }],
      ]),
      bySubscriptionId: new Map(),
    },
    close: vi.fn(),
  } as unknown as ExternalSourceController;
  const libraryManagement = {
    available: false,
    shelves: [],
    memberships: [],
    selectionMode: false,
    selectedBookIds: new Set(),
    busy: false,
  } as unknown as LibraryManagementController;
  return renderToStaticMarkup(
    <BookWorkspaceScreens
      textReader={{ settings } as unknown as SourceTextReaderOptions}
      controller={{} as BookWorkspaceController}
      state={state}
      projection={projection}
      libraryDrop={{ active: false, importBusy: false, actions: {} as never }}
      importTasks={[]}
      dismissImportTask={vi.fn()}
      bootstrap={{ status: 'ready', retry: vi.fn() }}
      sync={{ label: '연결 안 됨', tone: 'idle' }}
      annotationTotals={{ bookmarks: 0, highlights: 0, notes: 0 }}
      openSync={vi.fn()}
      openSettings={vi.fn()}
      openBackup={vi.fn()}
      openImport={vi.fn()}
      openChapterAppend={vi.fn()}
      openLibraryFolders={vi.fn()}
      externalSources={externalSources}
      openExternalSourceSettings={vi.fn()}
      addSample={vi.fn()}
      exportSource={vi.fn()}
      reselectSource={vi.fn()}
      reconstructSource={vi.fn()}
      openChapterStructure={vi.fn()}
      libraryManagement={libraryManagement}
      bookEnrichment={{} as BookEnrichmentController}
    />,
  );
}

describe('BookWorkspaceScreens source work progress', () => {
  it('passes the cover count preference through to cards and retains the progress basis toggle', () => {
    expect(render({ ...defaultSettings, showLibraryReadingCounts: true })).toContain('library-reading-count');
    expect(render(defaultSettings)).not.toContain('library-reading-count');
    expect(render({ ...defaultSettings, showLibraryReadingCounts: true })).toContain('title="30 / 120화"');
    expect(render({ ...defaultSettings, showLibraryReadingCounts: true, sourceProgressBasis: 'downloaded' })).toContain(
      'title="30 / 30화"',
    );
  });
  it('shows source works against the source release list by default', () => {
    const markup = render(defaultSettings);
    expect(markup).toContain('25%');
    expect(markup).not.toContain('100%');
  });

  it('returns to downloaded-chapter progress when that option is on', () => {
    const markup = render({ ...defaultSettings, sourceProgressBasis: 'downloaded' });
    expect(markup).toContain('100%');
    expect(markup).not.toContain('25%');
  });
});

it('keeps downloaded cards usable while source works load or fail', () => {
  const loading = render(defaultSettings, { status: 'loading' });
  expect(loading).toContain('소스 작품 불러오는 중');
  expect(loading).toContain('class="book-card');
  const failed = render(defaultSettings, { status: 'failed', message: '소스 작품 확인 실패' });
  expect(failed).toContain('소스 작품을 불러오지 못했습니다');
  expect(failed).toContain('class="book-card');
  expect(failed).toContain('다시 시도');
  expect(render(defaultSettings, { status: 'ready' })).toContain('class="book-card');
});

it.each([false, true])(
  'sorts a downloaded source book by its latest stream visit regardless of progress basis (%s)',
  (downloaded) => {
    const otherBook = testNovel({ id: 'ordinary', title: '일반 작품', lastReadAt: '2026-09-15T00:00:00.000Z' });
    const markup = render(
      { ...defaultSettings, ...(downloaded && { sourceProgressBasis: 'downloaded' as const }) },
      undefined,
      otherBook,
    );
    expect([...markup.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1])).toEqual(['소스 작품', '일반 작품']);
  },
);

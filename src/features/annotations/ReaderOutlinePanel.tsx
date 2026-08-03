import { Search } from 'lucide-react';
import type { Chapter } from '../../domain/types';
import { formatCount, formatProgress } from '../../utils/format';
import type { ChapterAnnotationCounts } from './annotation-model';

interface ReaderOutlinePanelProps {
  readonly chapters: readonly Chapter[];
  readonly filteredChapters: readonly Chapter[];
  readonly currentChapterId: string;
  readonly readChapter?: Chapter;
  readonly readChapterProgress: number;
  readonly annotationCounts: ReadonlyMap<string, ChapterAnnotationCounts>;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly openChapter: (chapter: Chapter, restore: boolean) => Promise<void>;
}

export function ReaderOutlinePanel({
  chapters,
  filteredChapters,
  currentChapterId,
  readChapter,
  readChapterProgress,
  annotationCounts,
  query,
  setQuery,
  openChapter,
}: ReaderOutlinePanelProps) {
  return (
    <div className="panel-body">
      <div className="panel-section-title">
        <h3>화 목록</h3>
        <span>
          {formatCount(filteredChapters.length)} / {formatCount(chapters.length)}
        </span>
      </div>
      <label className="search-box panel-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="화 번호나 제목 검색"
          aria-label="화 목록 검색"
        />
      </label>
      <div className="compact-list">
        {filteredChapters.length === 0 ? (
          <p className="empty-panel">검색 결과가 없습니다.</p>
        ) : (
          filteredChapters.map((chapter) => {
            const isActiveChapter = chapter.id === currentChapterId;
            const isSavedChapter = readChapter?.id === chapter.id;
            const isRead = readChapter !== undefined && chapter.index < readChapter.index;
            const counts = annotationCounts.get(chapter.id);
            return (
              <button
                key={chapter.id}
                type="button"
                className={`outline-row${isActiveChapter ? ' active' : ''}`}
                onClick={() => void openChapter(chapter, isSavedChapter)}
              >
                <span>
                  {chapter.index}. {chapter.title}
                </span>
                <small>{formatCount(chapter.characterCount)}자</small>
                <em>
                  {isActiveChapter
                    ? '현재'
                    : isSavedChapter
                      ? formatProgress(readChapterProgress)
                      : isRead
                        ? '읽음'
                        : ''}
                </em>
                {counts && (
                  <span className="outline-annotation-chips">
                    {counts.bookmarks > 0 && <i>북 {formatCount(counts.bookmarks)}</i>}
                    {counts.highlights > 0 && <i>하 {formatCount(counts.highlights)}</i>}
                    {counts.notes > 0 && <i>메 {formatCount(counts.notes)}</i>}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

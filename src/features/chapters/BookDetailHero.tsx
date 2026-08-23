import { Check, ChevronLeft, FilePenLine, ListTree, Pencil, Play, Star, Tags, X } from 'lucide-react';
import { formatCount, formatProgress } from '../../utils/format';
import { BookCover } from '../library/BookCover';
import { LibraryReadingProgress } from '../library/LibraryReadingProgress';
import type { ChaptersScreenProps } from './chapters-screen-contract';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function detailByline({ author, seriesTitle }: ChaptersScreenProps['model']['book']['novel']): string {
  return [author, seriesTitle].filter(Boolean).join(' · ');
}

function formatLabel(format: string | undefined): string {
  return (format ?? 'txt').toLocaleUpperCase();
}

export function BookDetailHero({ model, actions }: ChaptersScreenProps) {
  const { novel } = model.book;
  const byline = detailByline(novel);
  const directActionLabel = model.book.isUnread ? '첫 화 보기' : '이어 읽기';
  return (
    <section className="book-detail-hero" aria-labelledby="book-detail-title">
      <button type="button" className="detail-back-button" onClick={actions.navigation.backToLibrary}>
        <ChevronLeft size={17} /> 서재로
      </button>
      <div className="detail-hero-body">
        <div className="detail-hero-cover">
          <BookCover novel={novel} className={classNames('book-cover', model.book.coverClass)} />
        </div>
        <div className="detail-hero-copy">
          <span className="detail-status">{model.book.readingStatusLabel}</span>
          {model.titleEditor.editing ? (
            <form
              id="book-title-editor"
              className="book-title-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void actions.titleEditor.save();
              }}
            >
              <input
                value={model.titleEditor.draft}
                onChange={(event) => actions.titleEditor.setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    actions.titleEditor.cancel();
                  }
                }}
                autoFocus
                maxLength={120}
                aria-label="책 제목"
              />
              <button type="submit" title="저장" aria-label="책 제목 저장">
                <Check size={15} />
              </button>
              <button type="button" onClick={actions.titleEditor.cancel} title="취소" aria-label="책 제목 수정 취소">
                <X size={15} />
              </button>
            </form>
          ) : (
            <h1 id="book-detail-title">{novel.title}</h1>
          )}
          {byline && <p className="detail-byline">{byline}</p>}
          {novel.description && <p className="detail-description">{novel.description}</p>}
          {novel.tags && novel.tags.length > 0 && (
            <div className="detail-tags" aria-label="작품 태그">
              <Tags size={14} />
              {novel.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          )}
          <div className="detail-reading-progress">
            <div>
              <span>{model.book.readingPositionLabel}</span>
              <strong>{formatProgress(model.book.bookProgress)}</strong>
            </div>
            <LibraryReadingProgress
              novel={novel}
              progress={model.book.bookProgress}
              positionLabel={model.book.readingPositionLabel}
              className="progress-track"
            />
            <small>{model.book.lastReadLabel}</small>
          </div>
          <div className="detail-hero-actions">
            <button type="button" className="primary-btn" onClick={() => void actions.navigation.continueReading()}>
              <Play size={16} fill="currentColor" /> {directActionLabel}
            </button>
            <button
              type="button"
              className={novel.favorite ? 'is-favorite' : ''}
              onClick={() => void actions.book.toggleFavorite(novel)}
              aria-pressed={novel.favorite}
            >
              <Star size={17} fill={novel.favorite ? 'currentColor' : 'none'} /> 즐겨찾기
            </button>
            <button type="button" className="detail-edit-button" onClick={actions.navigation.openMetadata}>
              <FilePenLine size={17} /> 편집
            </button>
            <button
              type="button"
              className={classNames('detail-title-button', model.titleEditor.editing && 'is-active')}
              onClick={model.titleEditor.editing ? actions.titleEditor.cancel : actions.titleEditor.start}
              aria-controls="book-title-editor"
              aria-expanded={model.titleEditor.editing}
            >
              <Pencil size={17} /> 제목 수정
            </button>
            {novel.format !== 'epub' && (
              <button
                type="button"
                className="detail-structure-button"
                onClick={actions.navigation.openStructureEditor}
              >
                <ListTree size={17} /> 구조 편집
              </button>
            )}
          </div>
        </div>
      </div>
      <dl className="detail-stats">
        <div>
          <dt>형식</dt>
          <dd>{formatLabel(novel.format)}</dd>
        </div>
        <div>
          <dt>총 회차</dt>
          <dd>{formatCount(novel.totalChapters)}화</dd>
        </div>
        <div>
          <dt>누적 독서 시간</dt>
          <dd>{model.book.readingTimeLabel}</dd>
        </div>
        <div>
          <dt>분량</dt>
          <dd>{formatCount(novel.totalCharacters)}자</dd>
        </div>
      </dl>
    </section>
  );
}

import {
  BookOpen,
  BookmarkIcon,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  Headphones,
  Highlighter,
  ArrowDownToLine,
  LocateFixed,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelRightOpen,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  StickyNote,
  Sun,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { Bookmark, ReaderHighlight } from '../../domain/types';
import { useMenuPopover } from '../../shared/ui/use-menu-popover';
import { formatCount, formatProgress } from '../../utils/format';
import type { ReaderChromeController } from './use-reader-chrome';
import type { ReaderSearchController } from './use-reader-search';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  ReaderScreenHandle,
  ReaderScreenModel,
  ReaderSelection,
} from './reader-screen-contract';
import type { ReaderRuntimeFlow, ReaderViewportApi } from './ReaderViewport';
import { showChapterSequence } from './ReaderChapterHeading';
import { ReaderQuickViewDialog } from './ReaderQuickViewDialog';
import { normalizeReadingProfile } from '../reader-settings/reading-profile';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function chapterSubtitle(chapter: ReaderScreenModel['chapter']): string {
  return showChapterSequence(chapter) ? `${formatCount(chapter.index)}화 · ${chapter.title}` : chapter.title;
}

function flowLabel(readingFlow: ReaderRuntimeFlow): string {
  return readingFlow === 'paginated' ? '페이지' : '스크롤';
}

function paragraphProgressLabel(model: ReaderScreenModel, location?: ReaderLocationSnapshot): string {
  const total = model.chapter.paragraphCount;
  if (total <= 0) return '0 / 0 문단';
  const fallback = Math.max(1, Math.round((location?.progress ?? 0) * total));
  return `${formatCount(location?.paragraph?.index ?? location?.paragraphIndex ?? fallback)} / ${formatCount(total)} 문단`;
}

export interface ReaderChromeProps {
  readonly model: ReaderScreenModel;
  readonly screenHandle: ReaderScreenHandle;
  readonly viewport?: ReaderViewportApi;
  readonly chrome: ReaderChromeController;
  readonly search: ReaderSearchController;
  readonly location?: ReaderLocationSnapshot;
  readonly mode: ReaderMode;
  readonly readingFlow: ReaderRuntimeFlow;
  readonly activeBookmark?: Bookmark;
  readonly activeHighlight?: ReaderHighlight;
  readonly selection?: ReaderSelection;
  readonly mobileSearchOpen: boolean;
  readonly overflowOpen: boolean;
  readonly onSetMode: (mode: ReaderMode) => void;
  readonly onMobileSearchOpenChanged: (open: boolean) => void;
  readonly onOverflowOpenChanged: (open: boolean) => void;
  readonly onGoToSavedPosition: () => void;
  readonly onOpenAutoScroll?: () => void;
}

export function ReaderChrome({
  model,
  screenHandle,
  viewport,
  chrome,
  search,
  location,
  mode,
  readingFlow,
  activeBookmark,
  activeHighlight,
  selection,
  mobileSearchOpen,
  overflowOpen,
  onSetMode,
  onMobileSearchOpenChanged,
  onOverflowOpenChanged,
  onGoToSavedPosition,
  onOpenAutoScroll,
}: ReaderChromeProps) {
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const [highlightPending, setHighlightPending] = useState(false);
  const [quickViewOpen, setQuickViewOpen] = useState(false);
  const overflowMenu = useMenuPopover(overflowOpen, onOverflowOpenChanged);
  const actions = screenHandle.getActions();
  const progress = location?.progress ?? 0;
  const nightThemeActive = model.settings.theme === 'dark' || model.settings.theme === 'midnight';
  const readingProfile = normalizeReadingProfile(model.settings.readingProfile, model.settings);
  const bookOverrideEnabled = Boolean(model.settings.readingBookOverrides?.[model.novel.id]);
  const toggleBookmark = async () => {
    if (bookmarkPending) return;
    const currentLocation = location ?? viewport?.getLocation();
    if (!currentLocation) {
      actions.notify('읽기 위치를 확인하는 중입니다. 잠시 후 다시 시도해 주세요.', 'warning');
      return;
    }
    setBookmarkPending(true);
    try {
      await actions.toggleBookmark(currentLocation);
    } finally {
      setBookmarkPending(false);
    }
  };
  const addHighlight = async () => {
    if (!location || !selection || highlightPending) return;
    setHighlightPending(true);
    try {
      await actions.addHighlight(location, selection);
    } finally {
      setHighlightPending(false);
    }
  };
  const runOverflowAction = (action: () => void) => {
    onOverflowOpenChanged(false);
    overflowMenu.triggerRef.current?.focus();
    action();
  };

  return (
    <>
      <div className="top-progress">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <header className={classNames('reader-topbar', model.settings.keepScreenChrome && 'always-visible')}>
        <button className="icon-btn" onClick={actions.returnToChapters} title="화 목록" aria-label="화 목록으로">
          <ChevronLeft size={21} />
        </button>
        <div className="reader-title">
          <strong>{model.novel.title}</strong>
          <span>{chapterSubtitle(model.chapter)}</span>
        </div>
        <div className="reader-actions">
          <label className="search-box compact">
            <Search size={15} />
            <input
              ref={search.desktopInputRef}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={search.handleInputKeyDown}
              placeholder="본문 검색"
              aria-label="본문 검색"
            />
          </label>
          <button
            className="icon-btn reader-mobile-search-toggle"
            type="button"
            onClick={() => onMobileSearchOpenChanged(!mobileSearchOpen)}
            title="본문 검색"
            aria-label="본문 검색 열기"
            aria-expanded={mobileSearchOpen}
          >
            <Search size={18} />
          </button>
          <button
            className={classNames('icon-btn', 'reader-topbar-secondary', Boolean(activeBookmark) && 'active')}
            onClick={() => void toggleBookmark()}
            disabled={bookmarkPending}
            title={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크'}
            aria-label={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크 추가'}
            aria-busy={bookmarkPending}
            aria-pressed={Boolean(activeBookmark)}
          >
            <BookmarkIcon size={18} />
          </button>
          <button
            className={classNames('icon-btn', 'reader-topbar-secondary', Boolean(activeHighlight) && 'active')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={addHighlight}
            disabled={!selection || highlightPending}
            title={selection ? '선택 문장 하이라이트' : '본문에서 문장을 먼저 선택하세요'}
            aria-label="선택 문장 하이라이트"
          >
            <Highlighter size={18} />
          </button>
          <button
            className="icon-btn reader-topbar-secondary"
            onClick={() => setQuickViewOpen(true)}
            title="빠른 보기"
            aria-label="빠른 보기 열기"
          >
            <SlidersHorizontal size={18} />
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={onOpenAutoScroll}
            title="자동 스크롤"
            aria-label="자동 스크롤 설정"
          >
            <ArrowDownToLine size={18} />
          </button>
          <button
            className="icon-btn reader-topbar-secondary"
            onClick={actions.toggleAddon}
            title="부가 기능"
            aria-label="부가 기능 열기"
          >
            <PanelRightOpen size={18} />
          </button>
        </div>
      </header>

      {mobileSearchOpen && (
        <div className="reader-mobile-search" role="search">
          <label className="search-box compact">
            <Search size={16} />
            <input
              ref={search.mobileInputRef}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={search.handleInputKeyDown}
              placeholder="본문 검색"
              aria-label="모바일 본문 검색"
              autoFocus
            />
          </label>
          <button
            className="icon-btn"
            type="button"
            onClick={() => onMobileSearchOpenChanged(false)}
            aria-label="본문 검색 닫기"
          >
            <X size={18} />
          </button>
        </div>
      )}

      <footer
        className={classNames('reader-bottombar', model.settings.keepScreenChrome && 'always-visible')}
        aria-label="읽기 조작"
      >
        <div className="reader-position-bar">
          <button
            className="reader-chapter-step"
            type="button"
            disabled={!viewport || model.chapter.index <= 1}
            onClick={() => void viewport?.goChapter(-1)}
            title="이전 화"
            aria-label="이전 화"
          >
            <SkipBack size={18} /> <span>이전화</span>
          </button>
          <span className="reader-flow-pill">{flowLabel(readingFlow)}</span>
          <span className="progress-label">{formatProgress(progress)}</span>
          <input
            aria-label="읽기 진행률"
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={(event) => void viewport?.scrubTo(Number(event.target.value) / 1000)}
            title={`현재 화 진행률 ${formatProgress(progress)}`}
            aria-valuetext={`현재 화 진행률 ${formatProgress(progress)}`}
          />
          <span className="paragraph-progress-label">{paragraphProgressLabel(model, location)}</span>
          <button
            className="reader-chapter-step"
            type="button"
            disabled={!viewport || model.chapter.index >= model.chapters.length}
            onClick={() => void viewport?.goChapter(1)}
            title="다음 화"
            aria-label="다음 화"
          >
            <span>다음화</span> <SkipForward size={18} />
          </button>
        </div>
        <div className="reader-tool-row">
          <button
            className={classNames('reader-mobile-tool', model.addonOpen && model.addonTab === 'outline' && 'active')}
            type="button"
            onClick={() => actions.openAddon('outline')}
            title="목차"
            aria-label="목차 열기"
          >
            <BookOpen size={19} />
          </button>
          <button
            className={classNames('reader-mobile-tool', Boolean(activeBookmark) && 'active')}
            type="button"
            onClick={() => void toggleBookmark()}
            disabled={bookmarkPending}
            title={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크'}
            aria-label={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크 추가'}
            aria-busy={bookmarkPending}
            aria-pressed={Boolean(activeBookmark)}
          >
            <BookmarkIcon size={19} />
          </button>
          <button
            className={classNames('reader-mobile-tool', mode === 'listen' && 'active')}
            type="button"
            onClick={() => actions.startTTS(location?.ttsIndex ?? 0)}
            title="듣기"
            aria-label="듣기 시작"
            aria-pressed={mode === 'listen'}
          >
            <Headphones size={19} />
          </button>
          <button
            className="reader-mobile-tool"
            type="button"
            onClick={actions.toggleNightTheme}
            title="테마 전환"
            aria-label="테마 전환"
          >
            {nightThemeActive ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button
            className="reader-mobile-tool"
            type="button"
            onClick={() => setQuickViewOpen(true)}
            title="빠른 보기"
            aria-label="빠른 보기 열기"
          >
            <SlidersHorizontal size={19} />
          </button>
          <div className="reader-mode-switch" role="group" aria-label="읽기 및 듣기">
            <button
              type="button"
              className={mode === 'read' ? 'active' : ''}
              onClick={() => onSetMode('read')}
              title="읽기 모드"
              aria-label="읽기 모드"
              aria-pressed={mode === 'read'}
            >
              <BookOpen size={15} /> 읽기
            </button>
            <button
              type="button"
              className={mode === 'listen' ? 'active' : ''}
              onClick={() => actions.startTTS(location?.ttsIndex ?? 0)}
              title="듣기 모드"
              aria-label="듣기 모드"
              aria-pressed={mode === 'listen'}
            >
              <Headphones size={15} /> 듣기
            </button>
            <button
              className={classNames('reader-notes-action', model.addonOpen && model.addonTab === 'notes' && 'active')}
              onClick={() => actions.openAddon('notes')}
            >
              <StickyNote size={15} /> 주석
            </button>
          </div>
          <div className="reader-overflow" ref={overflowMenu.rootRef}>
            <button
              ref={overflowMenu.triggerRef}
              className="icon-btn reader-overflow-toggle"
              type="button"
              onClick={() => onOverflowOpenChanged(!overflowOpen)}
              aria-label="리더 추가 메뉴"
              aria-expanded={overflowOpen}
            >
              <MoreHorizontal size={19} />
            </button>
            {overflowOpen && (
              <div
                ref={overflowMenu.menuRef}
                className="reader-overflow-menu"
                role="menu"
                aria-label="리더 추가 작업"
                onKeyDown={overflowMenu.onMenuKeyDown}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runOverflowAction(() => void viewport?.scrollToParagraphIndex(0, 'start'))}
                >
                  <ChevronsLeft size={15} /> 현재 화 처음
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!model.canRestoreSavedPosition}
                  onClick={() => runOverflowAction(onGoToSavedPosition)}
                >
                  <LocateFixed size={15} /> 저장 위치
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    runOverflowAction(
                      () => void viewport?.scrollToParagraphIndex(model.chapter.paragraphCount - 1, 'end'),
                    )
                  }
                >
                  <ChevronsRight size={15} /> 현재 화 끝
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!selection || highlightPending}
                  onClick={() => runOverflowAction(addHighlight)}
                >
                  <Highlighter size={15} /> 선택 문장 하이라이트
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runOverflowAction(() => actions.openAddon('notes'))}
                >
                  <StickyNote size={15} /> 주석
                </button>
                <button type="button" role="menuitem" onClick={() => runOverflowAction(actions.openSync)}>
                  <RefreshCw size={15} /> 동기화
                </button>
                <button type="button" role="menuitem" onClick={() => runOverflowAction(() => setQuickViewOpen(true))}>
                  <SlidersHorizontal size={15} /> 빠른 보기
                </button>
                <button type="button" role="menuitem" onClick={() => runOverflowAction(actions.openSettings)}>
                  <Settings size={15} /> 전체 읽기 설정
                </button>
                {onOpenAutoScroll && (
                  <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenAutoScroll)}>
                    <ChevronsRight size={15} /> 자동 읽기
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => runOverflowAction(actions.toggleNightTheme)}>
                  {nightThemeActive ? <Sun size={15} /> : <Moon size={15} />} 테마
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runOverflowAction(() => void chrome.toggleFullscreen())}
                >
                  {chrome.fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />} 브라우저 전체 화면
                </button>
              </div>
            )}
          </div>
        </div>
      </footer>
      <ReaderQuickViewDialog
        open={quickViewOpen}
        profile={readingProfile}
        readingFlow={readingFlow}
        bookOverrideEnabled={bookOverrideEnabled}
        onClose={() => {
          actions.flushReadingSettings();
          setQuickViewOpen(false);
        }}
        saveState={model.settingsSaveState}
        onRetrySave={actions.retryReadingSettings}
        onUpdate={actions.updateReadingProfile}
        onSetBookOverride={actions.setReadingBookOverride}
        onOpenAllSettings={actions.openSettings}
      />
    </>
  );
}
